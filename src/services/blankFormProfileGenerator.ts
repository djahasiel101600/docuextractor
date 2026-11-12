/**
 * Builds an ExtractionProfile from blank-form analysis results plus the user's
 * widget-to-target assignments. Pure function: no network, no side effects,
 * so its output can be previewed and structurally validated before saving.
 *
 * Two generation modes, matching the two extraction methods:
 * - 'label' (default) keeps the widget-driven profile: contentRules.labels
 *   receives the verbatim on-page label text discovered next to each assigned
 *   widget (what the spatial matcher will re-find at extraction time) and the
 *   widget's own field name (what the AcroForm name matcher compares against).
 * - 'roi' additionally emits extractionSettings.method='roi' plus an
 *   annotationSchema holding the regions the operator drew. Those regions are
 *   the only thing ROI reads; assigned widgets stay in the labels for the
 *   label-run stripping and as corroboration, but are not required.
 *
 * In both modes filenameRules stay disabled (a blank form carries no filename
 * evidence) and AI stays disabled by default; OCR fallback stays enabled.
 */
import {
    AnnotationSchema,
    BlankFormAnalysis,
    ExtractionProfile,
    FieldDefinition,
    FormWidgetLayout,
} from '../types/extraction';

/** Which pipeline the generated profile will run. */
export type ProfileMethod = 'label' | 'roi';

/** A region the operator drew on a rendered page, in PDF points. */
export interface TargetBox {
    pageNumber: number;
    rect: PointRect;
}

export interface TargetAssignment {
    /** User-facing target name, e.g. "Candidate Name". */
    targetName: string;
    /** Widget ids from the analysis assigned to this target (fragment merge). */
    widgetIds: string[];
    /** Drawn regions; only ROI profiles read these, label profiles ignore them. */
    boxes: TargetBox[];
    required: boolean;
    fieldType: FieldDefinition['type'];
}

/** Rectangle in PDF point space, top-left origin: [x0, y0, x1, y1].
 *  Matches the `rect` field emitted by form_layout.py (PyMuPDF widget.rect,
 *  rounded to 1 decimal) so annotation geometry and widget geometry share
 *  one coordinate system and can be compared directly. */
export type PointRect = [number, number, number, number];

function normalizeRect([x0, y0, x1, y1]: PointRect): PointRect {
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Overlap area between two rects (0 when disjoint). */
function overlapArea(a: PointRect, b: PointRect): number {
    const ox = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const oy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    return ox * oy;
}

/**
 * Resolve which detected AcroForm widgets an annotation box "captures".
 *
 * This is the coordinate-mapping core of manual annotation: the user draws a
 * rectangle around the value they see on the rendered form; we map that box
 * back onto the widgets the backend already located (form_layout.py rects),
 * regardless of how generic their field names are (e.g. "f_2",
 * "topmostSubform[0].Page1[0].f_3"). Returned ids feed TargetAssignment.widget
 * Ids, so profile generation and runtime label/name matching are unchanged.
 *
 * A widget on the same page matches when ANY of these hold (robust to sloppy
 * boxes and to large multi-line widgets):
 *  - the widget's center falls inside the annotation box; or
 *  - the annotation covers >= 40% of the widget's area; or
 *  - the annotation is tiny and sits inside the widget (its center in widget).
 */
export function widgetsInAnnotation(
    widgets: FormWidgetLayout[],
    pageNumber: number,
    annotation: PointRect
): string[] {
    const box = normalizeRect(annotation);
    const boxCenter: [number, number] = [
        (box[0] + box[2]) / 2,
        (box[1] + box[3]) / 2,
    ];
    const matched: string[] = [];
    for (const widget of widgets) {
        if (widget.pageNumber !== pageNumber || !widget.rect) continue;
        const wRect = normalizeRect(widget.rect as PointRect);
        const wArea = Math.max(0, wRect[2] - wRect[0]) * Math.max(0, wRect[3] - wRect[1]);
        const centerInside =
            (wRect[0] + wRect[2]) / 2 >= box[0] &&
            (wRect[0] + wRect[2]) / 2 <= box[2] &&
            (wRect[1] + wRect[3]) / 2 >= box[1] &&
            (wRect[1] + wRect[3]) / 2 <= box[3];
        const coversWidget = wArea > 0 && overlapArea(box, wRect) / wArea >= 0.4;
        const insideWidget =
            boxCenter[0] >= wRect[0] &&
            boxCenter[1] >= wRect[1] &&
            boxCenter[0] <= wRect[2] &&
            boxCenter[1] <= wRect[3];
        if (centerInside || coversWidget || insideWidget) {
            matched.push(widget.id);
        }
    }
    return matched;
}

function slugifyId(name: string, taken: Set<string>): string {
    const base =
        name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'field';
    let candidate = base;
    let counter = 2;
    while (taken.has(candidate)) {
        candidate = `${base}_${counter}`;
        counter += 1;
    }
    taken.add(candidate);
    return candidate;
}

function buildField(
    assignment: TargetAssignment,
    widgets: FormWidgetLayout[],
    takenIds: Set<string>,
    method: ProfileMethod
): FieldDefinition {
    const assigned = widgets.filter((widget) =>
        assignment.widgetIds.includes(widget.id)
    );
    const labels: string[] = [];
    const pushLabel = (text?: string) => {
        const trimmed = (text || '').trim();
        if (
            trimmed &&
            trimmed.length > 1 &&
            !labels.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())
        ) {
            labels.push(trimmed);
        }
    };
    for (const widget of assigned) {
        // Best spatial label first, then alternates, then the widget's own name
        // (exact token match for the AcroForm name matcher) and alt label.
        widget.labels.forEach((label) => pushLabel(label.text));
        pushLabel(widget.fieldLabel);
        pushLabel(widget.fieldName);
    }
    // The first widget's suggestion drives derived rules; users refine in the
    // normal profile editor afterwards if needed.
    const suggestion = assigned[0]?.suggestion || {};
    // Defensive: an out-of-range type (stale state, manual edit) falls back to
    // text so the generated profile always passes structural validation.
    const allowedTypes: FieldDefinition['type'][] = [
        'text',
        'date',
        'number',
        'status',
        'email',
        'phone',
        'address',
        'checkbox',
    ];
    const type: FieldDefinition['type'] = allowedTypes.includes(assignment.fieldType)
        ? assignment.fieldType
        : 'text';

    const validation: FieldDefinition['validation'] = {};
    if (suggestion.validationRegex) {
        validation.formatRegex = suggestion.validationRegex;
    }
    if (suggestion.minLength) {
        validation.minLength = suggestion.minLength;
    }
    if ((type === 'status') && assigned[0]?.options?.length) {
        validation.allowedValues = assigned[0].options;
    }

    const normalization: FieldDefinition['normalization'] = {
        trim: true,
        caseTransform:
            (suggestion.caseTransform as FieldDefinition['normalization']['caseTransform']) || 'none',
        removeExtraSpaces: true,
    };
    if (type === 'date') {
        normalization.dateFormat = 'YYYY-MM-DD';
    }

    const widgetNames = assigned
        .map((widget) => widget.fieldName || widget.id)
        .join(', ');
    const pages = [
        ...new Set(assignment.boxes.map((box) => box.pageNumber)),
    ].sort((a, b) => a - b);
    const description =
        method === 'roi'
            ? `Generated from ${assignment.boxes.length} annotated region(s) on page(s) ${pages.join(', ')}.` +
              (widgetNames ? ` Widget(s): ${widgetNames}.` : '')
            : `Generated from blank-form widget(s): ${widgetNames}.`;

    return {
        id: slugifyId(assignment.targetName, takenIds),
        name: assignment.targetName.trim() || 'Untitled Field',
        label: assigned[0]?.labels[0]?.text || assignment.targetName,
        description,
        type,
        required: assignment.required,
        filenameRules: {
            enabled: false,
            patterns: [],
            captureGroup: 1,
            caseInsensitive: true,
        },
        contentRules: {
            // A ROI box-only target has no widget, so there is no printed
            // label to strip or re-find; leaving the rules enabled with an
            // empty label list would fail structural validation.
            enabled: labels.length > 0,
            labels,
            regexPatterns: [],
            positionHint: 'after_label',
        },
        priority: 'pdf_first',
        normalization,
        validation,
    };
}

/**
 * Group drawn boxes by page into the annotation schema shape the backend
 * validates: one entry per box, so a value split across two regions on one
 * page produces two boxes for the same fieldId (the reader tries them in
 * order). `fields` is index-aligned with `assignments`.
 */
function buildAnnotationSchema(
    assignments: TargetAssignment[],
    fields: FieldDefinition[]
): AnnotationSchema {
    const byPage = new Map<number, { fieldId: string; rect: PointRect }[]>();
    assignments.forEach((assignment, index) => {
        const fieldId = fields[index].id;
        for (const box of assignment.boxes) {
            const entries = byPage.get(box.pageNumber) || [];
            // Normalize so a box dragged up-left still stores x0<x1, y0<y1:
            // the backend rejects inverted rects.
            entries.push({ fieldId, rect: normalizeRect(box.rect) });
            byPage.set(box.pageNumber, entries);
        }
    });
    return {
        coordinateSystem: 'pdf-points-display-top-left',
        pages: [...byPage.entries()]
            .sort(([a], [b]) => a - b)
            .map(([pageNumber, entries]) => ({ pageNumber, fields: entries })),
    };
}

export function buildProfileFromBlankForm(
    analysis: BlankFormAnalysis,
    assignments: TargetAssignment[],
    meta: { name: string; description?: string },
    options: { method?: ProfileMethod } = {}
): ExtractionProfile {
    const method: ProfileMethod = options.method === 'roi' ? 'roi' : 'label';
    const takenIds = new Set<string>();
    // A ROI profile is unusable without boxes and a label profile is unusable
    // without widgets, so unusable targets are dropped rather than emitted as
    // fields that can never be filled.
    const usable = assignments.filter((assignment) =>
        method === 'roi'
            ? assignment.boxes.length > 0
            : assignment.widgetIds.length > 0
    );
    const fields = usable.map((assignment) =>
        buildField(assignment, analysis.widgets, takenIds, method)
    );
    const extractionSettings: NonNullable<ExtractionProfile['extractionSettings']> =
        { labelSimilarityThreshold: 0.82 };
    if (method === 'roi') {
        extractionSettings.method = 'roi';
        extractionSettings.annotationSchema = buildAnnotationSchema(usable, fields);
    }
    const timestamp = Date.now();
    return {
        id: `profile-blank-form-${timestamp}`,
        name: meta.name.trim() || 'Blank Form Profile',
        description:
            meta.description?.trim() ||
            'Auto-generated from a blank AcroForm template upload.',
        version: '1.0.0',
        fields,
        aiSettings: {
            enabled: false,
            baseUrl: 'http://127.0.0.1:11434',
            model: '',
            timeoutSeconds: 120,
            contextSize: 16384,
            strategy: 'review',
            allowCloudModels: false,
        },
        extractionSettings,
        ocrSettings: {
            enabledFallback: true,
            autoDetectScanned: true,
            minTextLengthThreshold: 50,
            language: 'eng',
            quality: 'standard',
        },
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
    };
}

/** Targets are only usable once they carry a name; ambiguity helper for UI.
 *  The geometry requirement follows the method: label matching needs at least
 *  one assigned widget, ROI needs an annotated region on every target (its
 *  widgets are optional corroboration). */
export function assignmentIssues(
    assignments: TargetAssignment[],
    method: ProfileMethod = 'label'
): string[] {
    const issues: string[] = [];
    const names = assignments.map((a) => a.targetName.trim().toLowerCase());
    names.forEach((name, index) => {
        if (!name) {
            issues.push(`Target #${index + 1} has no name.`);
        } else if (names.indexOf(name) !== index) {
            issues.push(`Duplicate target name "${assignments[index].targetName}".`);
        }
    });
    if (method === 'roi') {
        assignments.forEach((assignment, index) => {
            if (assignment.boxes.length === 0) {
                issues.push(
                    `Target #${index + 1} ("${assignment.targetName.trim() || 'unnamed'}") has no annotated region.`
                );
            }
        });
    } else if (!assignments.some((a) => a.widgetIds.length > 0)) {
        issues.push('Assign at least one form widget to a target.');
    }
    return issues;
}

/**
 * 'Create Profile from Blank Form' wizard.
 *
 * Add-on workflow only: it uploads an empty AcroForm PDF to the stateless
 * /api/forms/analyze/ endpoint, lets the user map discovered widgets to
 * extraction targets, generates a profile locally, dry-validates it against
 * /api/forms/validate-profile/, and hands the finished object to the same
 * onSaveProfile callback the regular editor uses. Nothing here modifies
 * existing profiles or jobs until the user explicitly clicks Create Profile.
 */
import React, {
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    AlertCircle,
    ArrowLeft,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    Crosshair,
    FileText,
    HelpCircle,
    Info,
    Plus,
    RotateCcw,
    Trash2,
    Upload,
    X,
    ZoomIn,
    ZoomOut,
} from 'lucide-react';
import {
    BlankFormAnalysis,
    ExtractionProfile,
    FieldDefinition,
    FormWidgetLayout,
} from '../../types/extraction';
import {
    analyzeBlankForm,
    getApiErrorMessage,
    validateProfileConfig,
} from '../../services/apiClient';
import {
    assignmentIssues,
    buildProfileFromBlankForm,
    PointRect,
    TargetAssignment,
    widgetsInAnnotation,
} from '../../services/blankFormProfileGenerator';
import { renderPdfPageToCanvas } from '../../services/pdfService';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface BlankFormProfileWizardProps {
    /** Existing profile names, used to block silent overwrites on save. */
    existingProfileNames: string[];
    onClose: () => void;
    /** Called only after backend validation passes and the user confirms. */
    onProfileReady: (profile: ExtractionProfile) => void;
}

type WizardStep = 'upload' | 'annotate' | 'map' | 'review';

const FIELD_TYPE_OPTIONS: FieldDefinition['type'][] = [
    'text',
    'date',
    'number',
    'status',
    'email',
    'phone',
    'address',
    'checkbox',
];

/** Plain-language explanation of what each type does at extraction time.
 *  Shown under the type selector so the user knows how the choice affects
 *  validation/normalization accuracy before saving the profile. */
const FIELD_TYPE_DESCRIPTIONS: Record<FieldDefinition['type'], string> = {
    text: 'Free-form value with no format check. Safest default when the content can be anything.',
    date: 'Expects a date. Values are normalized to YYYY-MM-DD and non-dates are flagged as mismatches.',
    number: 'Numeric value only. Stray letters or symbols cause a validation mismatch.',
    status: 'A value from a fixed list (e.g. Yes/No). When the widget carries options, only those are accepted.',
    email: 'Validates an email address format, catching typos and truncated values.',
    phone: 'Validates a phone number format and ignores harmless separators like spaces and dashes.',
    address: 'Multi-line street / city / postal value. Keeps line breaks instead of truncating.',
    checkbox: 'Yes/No box. X, check marks and 1 normalize to true; 0 and off normalize to false.',
};

/** Tooltip describing how the two matching sources use the assigned widgets. */
const WIDGET_ASSIGN_HINT =
    'A widget can only feed one target. For a value split across several boxes (e.g. first/last name, or address lines), assign every fragment so they merge into one field.';

function isAllowedType(value: string | undefined): value is FieldDefinition['type'] {
    return !!value && (FIELD_TYPE_OPTIONS as string[]).includes(value);
}

function widgetCaption(widget: FormWidgetLayout): string {
    const label = widget.labels[0]?.text;
    const short =
        label && label.length > 46 ? `${label.slice(0, 46).trimEnd()}…` : label;
    return (
        widget.fieldName ||
        widget.fieldLabel ||
        short ||
        `unnamed widget (page ${widget.pageNumber})`
    );
}

/** Rich hover detail for an assigned widget chip: field name, on-page label,
 *  widget kind and the analyzer's suggestion (with confidence + reason). */
function widgetDetail(widget: FormWidgetLayout): string {
    const parts: string[] = [];
    if (widget.fieldName) parts.push(`Field name: ${widget.fieldName}`);
    const labelText = widget.labels[0]?.text?.trim();
    if (labelText) parts.push(`On-page label: ${labelText}`);
    if (widget.kind) parts.push(`Widget kind: ${widget.kind}`);
    if (widget.suggestion?.reason) {
        const conf = widget.suggestion.confidence;
        const suggested =
            widget.suggestion.name || widget.suggestion.fieldType || '?';
        parts.push(
            `Suggested as “${suggested}”${typeof conf === 'number' ? ` (${Math.round(conf * 100)}%)` : ''
            } — ${widget.suggestion.reason}`
        );
    }
    return parts.join('\n');
}

/** Assign-dropdown option text: page, caption, and a preview of the label so
 *  users can tell similarly-named widgets apart when fine-tuning accuracy. */
function widgetOptionLabel(widget: FormWidgetLayout): string {
    const caption = widgetCaption(widget);
    const labelText = widget.labels[0]?.text?.trim();
    const preview =
        labelText && labelText !== caption
            ? ` — “${labelText.length > 40 ? `${labelText.slice(0, 40).trimEnd()}…` : labelText}”`
            : '';
    return `p${widget.pageNumber} · ${caption}${preview}`;
}

/** Group widgets that share a confident suggestion name into initial targets. */
function seedTargets(analysis: BlankFormAnalysis): TargetAssignment[] {
    const byName = new Map<string, TargetAssignment>();
    for (const widget of analysis.widgets) {
        const suggestion = widget.suggestion;
        if (!suggestion?.name || (suggestion.confidence ?? 0) < 0.5) {
            continue;
        }
        if (!isAllowedType(suggestion.fieldType)) {
            continue;
        }
        const key = suggestion.name.toLowerCase();
        const existing = byName.get(key);
        if (existing) {
            existing.widgetIds.push(widget.id);
        } else {
            byName.set(key, {
                targetName: suggestion.name,
                widgetIds: [widget.id],
                required: false,
                fieldType: suggestion.fieldType as FieldDefinition['type'],
            });
        }
    }
    return [...byName.values()];
}

export const BlankFormProfileWizard: React.FC<BlankFormProfileWizardProps> = ({
    existingProfileNames,
    onClose,
    onProfileReady,
}) => {
    const [step, setStep] = useState<WizardStep>('upload');
    const [analysis, setAnalysis] = useState<BlankFormAnalysis | null>(null);
    const [assignments, setAssignments] = useState<TargetAssignment[]>([]);
    const [profileName, setProfileName] = useState('');
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [dragActive, setDragActive] = useState(false);
    const [validationErrors, setValidationErrors] = useState<string[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- Manual annotation ("Annotate" step) state ---
    // The uploaded blank form is kept in memory (never stored) so pages can be
    // rendered for coordinate mapping.
    const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [zoom, setZoom] = useState(1.4);
    const [renderedSize, setRenderedSize] = useState<{ width: number; height: number } | null>(null);
    const [rendering, setRendering] = useState(false);
    const [renderFailed, setRenderFailed] = useState(false);
    // Live in-progress draw, in CSS pixels relative to the overlay.
    const [drawPx, setDrawPx] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
    // Finalized annotation (points) plus the widget ids it captured, awaiting a
    // target name before it becomes a TargetAssignment.
    const [pending, setPending] = useState<{ rect: PointRect; widgetIds: string[] } | null>(null);
    const [pendingName, setPendingName] = useState('');
    const [pendingType, setPendingType] = useState<FieldDefinition['type']>('text');
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const drawingRef = useRef(false);

    const assignedWidgetIds = useMemo(
        () => new Set(assignments.flatMap((target) => target.widgetIds)),
        [assignments]
    );
    const unassignedCount = analysis
        ? analysis.widgets.length - assignedWidgetIds.size
        : 0;

    const mappingIssues = useMemo(() => assignmentIssues(assignments), [assignments]);

    const handleFile = async (file: File | null | undefined) => {
        setError('');
        if (!file) {
            return;
        }
        if (!file.name.toLowerCase().endsWith('.pdf')) {
            setError('The blank form must be a PDF file.');
            return;
        }
        setBusy(true);
        try {
            const result = await analyzeBlankForm(file);
            setAnalysis(result);
            setAssignments(seedTargets(result));
            setProfileName(
                `${file.name.replace(/\.pdf$/i, '')} Profile`.slice(0, 200)
            );
            if (result.widgets.length > 0) {
                // Keep the bytes in memory so the Annotate step can render pages
                // and map drawn boxes onto widget coordinates. Never stored.
                try {
                    setPdfBuffer(await file.arrayBuffer());
                } catch {
                    setPdfBuffer(null);
                    setRenderFailed(true);
                }
                setCurrentPage(1);
                setRenderedSize(null);
                setPending(null);
                setDrawPx(null);
                setStep('annotate');
            } else {
                setPdfBuffer(null);
                setStep('upload');
                setError(
                    result.warnings[0] ||
                    'No fillable form fields were discovered in this PDF.'
                );
            }
        } catch (analyzeError) {
            setError(getApiErrorMessage(analyzeError));
        } finally {
            setBusy(false);
        }
    };

    const updateAssignment = (
        index: number,
        updates: Partial<TargetAssignment>
    ) => {
        setAssignments((current) =>
            current.map((target, i) => (i === index ? { ...target, ...updates } : target))
        );
    };

    const toggleWidget = (targetIndex: number, widgetId: string) => {
        setAssignments((current) =>
            current.map((target, i) => {
                if (i === targetIndex) {
                    return {
                        ...target,
                        widgetIds: target.widgetIds.includes(widgetId)
                            ? target.widgetIds.filter((id) => id !== widgetId)
                            : [...target.widgetIds, widgetId],
                    };
                }
                // A widget may only feed one target; claiming it here releases it
                // from its previous target (mirrors the engine's widget ownership).
                return {
                    ...target,
                    widgetIds: target.widgetIds.filter((id) => id !== widgetId),
                };
            })
        );
    };

    const addTarget = () => {
        setAssignments((current) => [
            ...current,
            {
                targetName: `Target ${current.length + 1}`,
                widgetIds: [],
                required: false,
                fieldType: 'text',
            },
        ]);
    };

    const resetWizard = () => {
        setAnalysis(null);
        setAssignments([]);
        setProfileName('');
        setDescription('');
        setError('');
        setValidationErrors([]);
        setPdfBuffer(null);
        setCurrentPage(1);
        setZoom(1.4);
        setRenderedSize(null);
        setRenderFailed(false);
        setDrawPx(null);
        setPending(null);
        setPendingName('');
        setStep('upload');
    };

    const generatePreview = () => {
        if (!analysis) {
            return;
        }
        const profile = buildProfileFromBlankForm(
            analysis,
            assignments.filter((assignment) => assignment.widgetIds.length > 0),
            { name: profileName, description }
        );
        setPreviewProfile(profile);
        setStep('review');
    };

    const [previewProfile, setPreviewProfile] = useState<ExtractionProfile | null>(
        null
    );

    const handleCreate = async () => {
        if (!previewProfile) {
            return;
        }
        setError('');
        if (
            existingProfileNames.some(
                (name) => name.toLowerCase() === previewProfile.name.toLowerCase()
            )
        ) {
            setError(
                'A profile with this name already exists. Choose a different name (use the Profiles editor to modify an existing profile).'
            );
            return;
        }
        setBusy(true);
        try {
            const result = await validateProfileConfig(previewProfile);
            if (!result.valid) {
                setValidationErrors(result.errors);
                setBusy(false);
                return;
            }
            setValidationErrors([]);
            onProfileReady(previewProfile);
        } catch (validateError) {
            setError(getApiErrorMessage(validateError));
        } finally {
            setBusy(false);
        }
    };

    // ------------------------------------------------------------------
    // Manual annotation: render the current page, then translate a drawn
    // pixel box back into PDF points and resolve the widgets it captures.
    // ------------------------------------------------------------------
    const startRef = useRef<{ x: number; y: number } | null>(null);

    const currentPageMeta = useMemo(
        () => analysis?.pages.find((page) => page.pageNumber === currentPage) || null,
        [analysis, currentPage]
    );
    const pageWidgets = useMemo(
        () => (analysis ? analysis.widgets.filter((w) => w.pageNumber === currentPage) : []),
        [analysis, currentPage]
    );
    // CSS pixels per PDF point, computed per-axis from the rendered canvas so
    // rounding in either PyMuPDF or PDF.js never skews the coordinate mapping.
    const ppp = renderedSize && currentPageMeta && currentPageMeta.width > 0 && currentPageMeta.height > 0
        ? {
            x: renderedSize.width / currentPageMeta.width,
            y: renderedSize.height / currentPageMeta.height,
        }
        : null;

    // Widgets lit up green inside the current box: the finalized pending box
    // when it exists, otherwise the box being dragged right now.
    const highlightWidgetIds = useMemo(() => {
        if (!analysis) return new Set<string>();
        if (pending) return new Set(pending.widgetIds);
        if (drawPx && ppp) {
            const rect: PointRect = [
                Math.min(drawPx.x0, drawPx.x1) / ppp.x,
                Math.min(drawPx.y0, drawPx.y1) / ppp.y,
                Math.max(drawPx.x0, drawPx.x1) / ppp.x,
                Math.max(drawPx.y0, drawPx.y1) / ppp.y,
            ];
            return new Set(widgetsInAnnotation(analysis.widgets, currentPage, rect));
        }
        return new Set<string>();
    }, [analysis, pending, drawPx, ppp, currentPage]);

    useEffect(() => {
        if (step !== 'annotate' || !pdfBuffer || !analysis) {
            return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        let cancelled = false;
        setRendering(true);
        setRenderFailed(false);
        // This canvas is the measuring surface for PDF-point rectangles; a
        // synthetic fallback page would yield real-looking but fabricated
        // geometry, so a render failure must surface instead.
        renderPdfPageToCanvas(pdfBuffer, currentPage, canvas, zoom, undefined, undefined, {
            allowFallback: false,
        })
            .then((size) => {
                if (cancelled) return;
                setRenderedSize(size);
                setRendering(false);
            })
            .catch(() => {
                if (cancelled) return;
                setRenderFailed(true);
                setRendering(false);
            });
        return () => {
            cancelled = true;
        };
    }, [step, pdfBuffer, analysis, currentPage, zoom]);

    const localPoint = (event: React.PointerEvent) => {
        const el = overlayRef.current;
        if (!el) return null;
        const bounds = el.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width)),
            y: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height)),
        };
    };

    const handlePointerDown = (event: React.PointerEvent) => {
        if (!ppp) return;
        const point = localPoint(event);
        if (!point) return;
        (event.target as Element).setPointerCapture?.(event.pointerId);
        drawingRef.current = true;
        startRef.current = point;
        setPending(null);
        setDrawPx({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
    };

    const handlePointerMove = (event: React.PointerEvent) => {
        if (!drawingRef.current || !startRef.current) return;
        const point = localPoint(event);
        if (!point) return;
        setDrawPx({ x0: startRef.current.x, y0: startRef.current.y, x1: point.x, y1: point.y });
    };

    const handlePointerUp = (event: React.PointerEvent) => {
        if (!drawingRef.current || !startRef.current || !ppp || !analysis) {
            drawingRef.current = false;
            return;
        }
        drawingRef.current = false;
        const start = startRef.current;
        const end = localPoint(event) || start;
        startRef.current = null;
        setDrawPx(null);
        // Ignore stray clicks (a box under ~5px carries no intent).
        if (Math.abs(end.x - start.x) < 5 || Math.abs(end.y - start.y) < 5) {
            return;
        }
        const rect: PointRect = [
            Math.min(start.x, end.x) / ppp.x,
            Math.min(start.y, end.y) / ppp.y,
            Math.max(start.x, end.x) / ppp.x,
            Math.max(start.y, end.y) / ppp.y,
        ];
        const matched = widgetsInAnnotation(analysis.widgets, currentPage, rect);
        const first = matched.length
            ? analysis.widgets.find((w) => w.id === matched[0])
            : undefined;
        const suggestion = first?.suggestion;
        if (isAllowedType(suggestion?.fieldType)) {
            setPendingType(suggestion!.fieldType as FieldDefinition['type']);
        }
        setPendingName(
            suggestion?.name || `Target ${assignments.length + 1}`
        );
        setPending({ rect, widgetIds: matched });
    };

    const commitPending = () => {
        if (!pending || pending.widgetIds.length === 0) return;
        const name = pendingName.trim() || `Target ${assignments.length + 1}`;
        const claimed = new Set(pending.widgetIds);
        setAssignments((current) => {
            // Claiming a widget releases it from any previous target so the
            // one-widget-one-target invariant (mirrored by toggleWidget) holds.
            const stripped = current.map((target) => ({
                ...target,
                widgetIds: target.widgetIds.filter((id) => !claimed.has(id)),
            }));
            return [
                ...stripped,
                {
                    targetName: name,
                    widgetIds: pending.widgetIds,
                    required: false,
                    fieldType: pendingType,
                },
            ];
        });
        setPending(null);
        setPendingName('');
    };

    const stepBadge = (current: WizardStep, label: string) => {
        const order: WizardStep[] = ['upload', 'annotate', 'map', 'review'];
        const active = order.indexOf(step) >= order.indexOf(current);
        return (
            <span
                className={`flex items-center gap-1.5 text-[11px] font-semibold ${active ? 'text-neutral-900' : 'text-neutral-400'
                    }`}
            >
                <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${active ? 'bg-neutral-900 text-white' : 'bg-neutral-200 text-neutral-500'
                        }`}
                >
                    {order.indexOf(current) + 1}
                </span>
                {label}
            </span>
        );
    };

    return (
        <div className="fixed inset-0 z-50 bg-neutral-900/60 backdrop-blur-xs flex items-center justify-center p-4">
            <div className={`bg-white rounded-xl shadow-2xl border border-neutral-200 w-full max-h-[92vh] flex flex-col overflow-hidden ${step === 'annotate' ? 'max-w-6xl' : 'max-w-4xl'}`}>
                {/* Top bar */}
                <div className="flex items-center justify-between px-6 py-3.5 border-b border-neutral-200 bg-neutral-50/70 shrink-0">
                    <div className="flex items-center gap-4">
                        <h3 className="text-sm font-bold text-neutral-900">
                            Create Profile from Blank Form
                        </h3>
                        <div className="hidden sm:flex items-center gap-4">
                            {stepBadge('upload', 'Upload')}
                            {stepBadge('annotate', 'Annotate')}
                            {stepBadge('map', 'Map fields')}
                            {stepBadge('review', 'Review & save')}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-md hover:bg-neutral-200 text-neutral-500"
                        title="Close wizard"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-4">
                    {error && (
                        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span>{error}</span>
                        </div>
                    )}

                    {step === 'upload' && (
                        <div className="space-y-4">
                            <p className="text-xs text-neutral-600">
                                Upload an <strong>empty</strong> copy of the PDF form (the
                                template before anyone fills it in). DocuExtractor reads its
                                fillable fields and on-page labels to suggest extraction
                                targets. Nothing is saved yet.
                            </p>
                            <div
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    setDragActive(true);
                                }}
                                onDragLeave={() => setDragActive(false)}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    setDragActive(false);
                                    void handleFile(e.dataTransfer.files?.[0]);
                                }}
                                onClick={() => fileInputRef.current?.click()}
                                className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${dragActive
                                    ? 'border-neutral-900 bg-neutral-50'
                                    : 'border-neutral-300 hover:border-neutral-500 hover:bg-neutral-50/60'
                                    }`}
                            >
                                <Upload className="w-6 h-6 text-neutral-500" />
                                <span className="text-sm font-semibold text-neutral-800">
                                    {busy
                                        ? 'Analyzing form structure…'
                                        : 'Drop the blank PDF form here, or click to browse'}
                                </span>
                                <span className="text-[11px] text-neutral-500">
                                    The file is analyzed in memory only; it is never stored.
                                </span>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="application/pdf,.pdf"
                                    className="hidden"
                                    onChange={(e) => void handleFile(e.target.files?.[0])}
                                />
                            </div>
                            {busy && (
                                <div className="flex items-center gap-2 text-xs text-neutral-600">
                                    <div className="w-4 h-4 border-2 border-neutral-900 border-t-transparent rounded-full animate-spin" />
                                    Reading widgets and label geometry…
                                </div>
                            )}
                        </div>
                    )}

                    {step === 'annotate' && analysis && (
                        <div className="space-y-3">
                            <p className="text-xs text-neutral-600 leading-relaxed">
                                <strong className="text-neutral-800">Optional but most accurate.</strong>{' '}
                                Detected fields often have generic names (e.g.{' '}
                                <code className="px-1 bg-neutral-100 rounded font-mono">f_2</code>).
                                Click-and-drag a box around each value on the page to map it to a named
                                target: DocuExtractor records the box, finds the detected field(s) inside
                                it, and assigns them to that target. Or skip ahead to fine-tune the
                                auto-suggestions in the next screen.
                            </p>

                            {/* Toolbar: page nav + zoom + legend */}
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <div className="flex items-center gap-1">
                                    <button
                                        disabled={currentPage <= 1}
                                        onClick={() => {
                                            setPending(null);
                                            setDrawPx(null);
                                            setCurrentPage((p) => Math.max(1, p - 1));
                                        }}
                                        className="p-1 rounded hover:bg-neutral-100 disabled:opacity-30"
                                        title="Previous page"
                                    >
                                        <ChevronLeft className="w-4 h-4" />
                                    </button>
                                    <span className="font-mono tabular-nums px-1 text-neutral-700">
                                        Page {currentPage} of {analysis.pageCount}
                                    </span>
                                    <button
                                        disabled={currentPage >= analysis.pageCount}
                                        onClick={() => {
                                            setPending(null);
                                            setDrawPx(null);
                                            setCurrentPage((p) => Math.min(analysis!.pageCount, p + 1));
                                        }}
                                        className="p-1 rounded hover:bg-neutral-100 disabled:opacity-30"
                                        title="Next page"
                                    >
                                        <ChevronRight className="w-4 h-4" />
                                    </button>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => setZoom((z) => Math.max(0.7, +(z - 0.2).toFixed(2)))}
                                        className="p-1 rounded hover:bg-neutral-100"
                                        title="Zoom out"
                                    >
                                        <ZoomOut className="w-4 h-4" />
                                    </button>
                                    <span className="font-mono tabular-nums px-1 text-neutral-500">
                                        {Math.round(zoom * 100)}%
                                    </span>
                                    <button
                                        onClick={() => setZoom((z) => Math.min(2.6, +(z + 0.2).toFixed(2)))}
                                        className="p-1 rounded hover:bg-neutral-100"
                                        title="Zoom in"
                                    >
                                        <ZoomIn className="w-4 h-4" />
                                    </button>
                                </div>
                                <div className="flex items-center gap-2.5 text-[10px] text-neutral-500">
                                    <span className="flex items-center gap-1">
                                        <span className="inline-block w-3 h-2 border border-dashed border-neutral-400 bg-neutral-900/5" />
                                        detected field
                                    </span>
                                    <span className="flex items-center gap-1">
                                        <span className="inline-block w-3 h-2 border border-sky-500 bg-sky-500/10" />
                                        already mapped
                                    </span>
                                    <span className="flex items-center gap-1">
                                        <span className="inline-block w-3 h-2 border border-emerald-600 bg-emerald-500/25" />
                                        captured by box
                                    </span>
                                </div>
                            </div>

                            {/* Page viewer with drawing overlay */}
                            <div className="rounded-lg border border-neutral-200 bg-neutral-100 overflow-auto max-h-[50vh] p-4 flex justify-center">
                                {renderFailed ? (
                                    <div className="max-w-md text-center space-y-3 py-6">
                                        <AlertCircle className="w-7 h-7 text-rose-500 mx-auto" />
                                        <p className="text-xs text-neutral-700">
                                            The page preview could not be rendered in this browser, so
                                            annotation is unavailable. You can still map fields
                                            automatically in the next step.
                                        </p>
                                        <Button variant="outline" size="sm" onClick={() => setStep('map')}>
                                            Skip to Mapping
                                        </Button>
                                    </div>
                                ) : (
                                    <div
                                        className="relative shadow-md bg-white rounded-xs"
                                        style={{
                                            width: renderedSize?.width ?? (currentPageMeta ? currentPageMeta.width * zoom : 612),
                                            height: renderedSize?.height ?? (currentPageMeta ? currentPageMeta.height * zoom : 792),
                                        }}
                                    >
                                        <canvas ref={canvasRef} className="block max-w-full" />
                                        {ppp && (
                                            <div
                                                ref={overlayRef}
                                                className="absolute inset-0 cursor-crosshair select-none"
                                                style={{ touchAction: 'none' }}
                                                onPointerDown={handlePointerDown}
                                                onPointerMove={handlePointerMove}
                                                onPointerUp={handlePointerUp}
                                                onPointerCancel={() => {
                                                    drawingRef.current = false;
                                                    setDrawPx(null);
                                                }}
                                            >
                                                <svg
                                                    width={renderedSize?.width}
                                                    height={renderedSize?.height}
                                                    className="absolute inset-0"
                                                >
                                                    {pageWidgets.map((widget) => {
                                                        if (!widget.rect) return null;
                                                        const [wx0, wy0, wx1, wy1] = widget.rect;
                                                        const captured = highlightWidgetIds.has(widget.id);
                                                        const mapped = assignedWidgetIds.has(widget.id);
                                                        return (
                                                            <rect
                                                                key={widget.id}
                                                                x={wx0 * ppp.x}
                                                                y={wy0 * ppp.y}
                                                                width={Math.max(1, (wx1 - wx0) * ppp.x)}
                                                                height={Math.max(1, (wy1 - wy0) * ppp.y)}
                                                                className={
                                                                    captured
                                                                        ? 'fill-emerald-500/25 stroke-emerald-600'
                                                                        : mapped
                                                                            ? 'fill-sky-500/10 stroke-sky-500'
                                                                            : 'fill-neutral-900/5 stroke-neutral-400'
                                                                }
                                                                strokeWidth={captured ? 1.5 : 1}
                                                                strokeDasharray={captured || mapped ? undefined : '3 2'}
                                                            >
                                                                <title>{widgetDetail(widget)}</title>
                                                            </rect>
                                                        );
                                                    })}
                                                    {drawPx && (
                                                        <rect
                                                            x={Math.min(drawPx.x0, drawPx.x1)}
                                                            y={Math.min(drawPx.y0, drawPx.y1)}
                                                            width={Math.abs(drawPx.x1 - drawPx.x0)}
                                                            height={Math.abs(drawPx.y1 - drawPx.y0)}
                                                            className="fill-indigo-500/10 stroke-indigo-600"
                                                            strokeWidth={1.5}
                                                            strokeDasharray="4 2"
                                                        />
                                                    )}
                                                    {pending && (
                                                        <rect
                                                            x={pending.rect[0] * ppp.x}
                                                            y={pending.rect[1] * ppp.y}
                                                            width={Math.max(2, (pending.rect[2] - pending.rect[0]) * ppp.x)}
                                                            height={Math.max(2, (pending.rect[3] - pending.rect[1]) * ppp.y)}
                                                            className="fill-none stroke-indigo-600"
                                                            strokeWidth={2}
                                                        />
                                                    )}
                                                </svg>
                                            </div>
                                        )}
                                        {rendering && (
                                            <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                                                <div className="flex items-center gap-2 text-xs text-neutral-600">
                                                    <div className="w-4 h-4 border-2 border-neutral-900 border-t-transparent rounded-full animate-spin" />
                                                    Rendering page…
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                                <Crosshair className="w-3.5 h-3.5" />
                                Drag a box over a value — highlighted fields are the ones it will capture.
                                A box that spans several fragments merges them into one target.
                            </p>

                            {/* Pending commit bar */}
                            {pending && (
                                <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 space-y-2">
                                    {pending.widgetIds.length === 0 ? (
                                        <p className="text-[11px] text-amber-800 flex items-start gap-1.5">
                                            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                            This box didn't overlap any detected field. Adjust it to
                                            cover a field (the dashed outlines), or draw again.
                                        </p>
                                    ) : (
                                        <>
                                            <p className="text-[11px] text-neutral-700">
                                                Captured{' '}
                                                <strong>{pending.widgetIds.length}</strong> field(s):
                                            </p>
                                            <div className="flex flex-wrap gap-1">
                                                {pending.widgetIds.map((id) => {
                                                    const widget = analysis.widgets.find((w) => w.id === id);
                                                    return widget ? (
                                                        <span
                                                            key={id}
                                                            className="inline-flex items-center rounded-full bg-white border border-emerald-200 text-emerald-800 px-2 py-0.5 text-[10px]"
                                                            title={widgetDetail(widget)}
                                                        >
                                                            {widgetCaption(widget)}
                                                        </span>
                                                    ) : null;
                                                })}
                                            </div>
                                            <div className="flex flex-wrap items-end gap-2 pt-1">
                                                <div className="flex-1 min-w-48 space-y-1">
                                                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                                                        Target name
                                                    </label>
                                                    <input
                                                        value={pendingName}
                                                        autoFocus
                                                        onChange={(e) => setPendingName(e.target.value)}
                                                        placeholder="e.g. Candidate Name"
                                                        className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs font-medium"
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                                                        Field type
                                                    </label>
                                                    <select
                                                        value={pendingType}
                                                        onChange={(e) =>
                                                            setPendingType(e.target.value as FieldDefinition['type'])
                                                        }
                                                        className="px-2 py-1.5 border border-neutral-300 rounded text-xs bg-white"
                                                    >
                                                        {FIELD_TYPE_OPTIONS.map((type) => (
                                                            <option key={type} value={type}>
                                                                {type}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Button size="sm" onClick={commitPending}>
                                                        <Plus className="w-3.5 h-3.5" />
                                                        <span>Add Target</span>
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => setPending(null)}
                                                    >
                                                        Cancel
                                                    </Button>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* Step actions */}
                            <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                                <Button variant="secondary" onClick={resetWizard}>
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    <span>Use Another Form</span>
                                </Button>
                                <div className="flex items-center gap-3">
                                    <span className="text-[11px] text-neutral-500">
                                        {assignments.length} target(s) configured
                                    </span>
                                    <Button variant="outline" onClick={() => setStep('upload')}>
                                        <ArrowLeft className="w-3.5 h-3.5" />
                                        <span>Back</span>
                                    </Button>
                                    <Button onClick={() => setStep('map')} disabled={rendering}>
                                        <span>Continue to Mapping</span>
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 'map' && analysis && (
                        <div className="space-y-4">
                            <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-700">
                                <span className="flex items-center gap-1.5 font-semibold">
                                    <FileText className="w-3.5 h-3.5" />
                                    {analysis.widgetCount} field(s) across {analysis.pageCount}{' '}
                                    page(s)
                                </span>
                                <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${analysis.isBlank
                                        ? 'bg-emerald-100 text-emerald-800'
                                        : 'bg-amber-100 text-amber-800'
                                        }`}
                                >
                                    {analysis.isBlank
                                        ? 'Blank template'
                                        : `${analysis.prefilledCount} prefilled value(s) detected`}
                                </span>
                                {unassignedCount > 0 && (
                                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-600">
                                        {unassignedCount} unassigned
                                    </span>
                                )}
                            </div>

                            {analysis.warnings.length > 0 && (
                                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1">
                                    {analysis.warnings.map((warning, i) => (
                                        <p
                                            key={i}
                                            className="text-[11px] text-amber-900 flex items-start gap-1.5"
                                        >
                                            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                                            {warning}
                                        </p>
                                    ))}
                                </div>
                            )}

                            <div className="space-y-3">
                                <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                                    Extraction Targets
                                </span>
                                <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 space-y-1.5">
                                    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-neutral-700">
                                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-neutral-500" />
                                        <span>
                                            Map each value you want to export to the form
                                            field(s) that hold it. DocuExtractor finds a
                                            value two ways — by the widget's
                                            <strong> field name</strong> and by the
                                            <strong> on-page label</strong> printed beside
                                            it. Assigning the right widgets is what drives
                                            accuracy; pick a field type to turn on
                                            automatic validation.
                                        </span>
                                    </p>
                                </div>
                                {assignments.length === 0 && (
                                    <p className="text-xs text-neutral-500 italic">
                                        No confident suggestions were found — add a target
                                        below and assign its form fields to get started.
                                    </p>
                                )}
                                {assignments.map((target, index) => {
                                    const matched = analysis.widgets.filter((widget) =>
                                        target.widgetIds.includes(widget.id)
                                    );
                                    return (
                                        <div
                                            key={index}
                                            className="rounded-lg border border-neutral-200 p-3 space-y-2.5 bg-white"
                                        >
                                            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-start">
                                                <div className="space-y-1">
                                                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                                                        Target name
                                                    </label>
                                                    <input
                                                        value={target.targetName}
                                                        onChange={(e) =>
                                                            updateAssignment(index, { targetName: e.target.value })
                                                        }
                                                        placeholder="e.g. Candidate Name"
                                                        className="w-full min-w-48 px-2.5 py-1.5 border border-neutral-300 rounded text-xs font-medium"
                                                    />
                                                    <p className="text-[10px] text-neutral-400">
                                                        The column / field name shown in your export.
                                                    </p>
                                                </div>
                                                <div className="space-y-1">
                                                    <label className="block text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                                                        Field type
                                                    </label>
                                                    <select
                                                        value={target.fieldType}
                                                        onChange={(e) =>
                                                            updateAssignment(index, {
                                                                fieldType: e.target.value as FieldDefinition['type'],
                                                            })
                                                        }
                                                        className="w-full px-2 py-1.5 border border-neutral-300 rounded text-xs bg-white"
                                                        title="Pick the value type to enable automatic validation"
                                                    >
                                                        {FIELD_TYPE_OPTIONS.map((type) => (
                                                            <option key={type} value={type}>
                                                                {type}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <label
                                                    className="flex items-center gap-1.5 h-8 px-2 rounded border border-neutral-200 text-[11px] text-neutral-600 cursor-pointer hover:bg-neutral-50"
                                                    title="Missing values for this field will be flagged for review."
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={target.required}
                                                        onChange={(e) =>
                                                            updateAssignment(index, { required: e.target.checked })
                                                        }
                                                    />
                                                    Required
                                                </label>
                                                <button
                                                    onClick={() =>
                                                        setAssignments((current) =>
                                                            current.filter((_, i) => i !== index)
                                                        )
                                                    }
                                                    className="h-8 p-1.5 rounded hover:bg-rose-50 text-rose-600"
                                                    title="Remove target"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>

                                            <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-neutral-500 bg-neutral-50 rounded px-2 py-1.5">
                                                <Info className="w-3 h-3 shrink-0 mt-0.5" />
                                                <span>{FIELD_TYPE_DESCRIPTIONS[target.fieldType]}</span>
                                            </p>

                                            <div className="space-y-1.5">
                                                <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                                                    Assigned form fields
                                                    <span title={WIDGET_ASSIGN_HINT} className="inline-flex cursor-help">
                                                        <HelpCircle className="w-3 h-3 text-neutral-400" />
                                                    </span>
                                                </label>
                                                <div className="flex flex-wrap gap-1.5">
                                                    {matched.map((widget) => (
                                                        <span
                                                            key={widget.id}
                                                            className="inline-flex items-center gap-1 rounded-full bg-neutral-900 text-white px-2 py-0.5 text-[10px]"
                                                            title={widgetDetail(widget)}
                                                        >
                                                            {widgetCaption(widget)}
                                                            <button
                                                                onClick={() => toggleWidget(index, widget.id)}
                                                                className="text-neutral-400 hover:text-white"
                                                                title="Unassign widget"
                                                            >
                                                                ×
                                                            </button>
                                                        </span>
                                                    ))}
                                                    <select
                                                        value=""
                                                        onChange={(e) => {
                                                            if (e.target.value) {
                                                                toggleWidget(index, e.target.value);
                                                            }
                                                        }}
                                                        className="border border-dashed border-neutral-300 rounded-full px-2 py-0.5 text-[10px] text-neutral-500 bg-white hover:border-neutral-400"
                                                        title="Assign a form field that holds this value"
                                                    >
                                                        <option value="">+ assign a form field…</option>
                                                        {analysis.widgets
                                                            .filter(
                                                                (widget) =>
                                                                    !assignedWidgetIds.has(widget.id) ||
                                                                    target.widgetIds.includes(widget.id)
                                                            )
                                                            .map((widget) => (
                                                                <option key={widget.id} value={widget.id}>
                                                                    {widgetOptionLabel(widget)}
                                                                </option>
                                                            ))}
                                                    </select>
                                                    {target.widgetIds.length === 0 && (
                                                        <p className="flex items-start gap-1 text-[10px] text-amber-700">
                                                            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
                                                            No form field assigned yet — this target will be skipped during generation.
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                                <Button variant="outline" size="sm" onClick={addTarget}>
                                    <Plus className="w-3.5 h-3.5" />
                                    <span>Add Target</span>
                                </Button>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                                <Button variant="secondary" onClick={resetWizard}>
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    <span>Use Another Form</span>
                                </Button>
                                <div className="flex items-center gap-3">
                                    {mappingIssues.length > 0 && (
                                        <span className="text-[11px] text-rose-700 max-w-sm text-right">
                                            {mappingIssues[0]}
                                        </span>
                                    )}
                                    <Button
                                        variant="outline"
                                        onClick={() => setStep('annotate')}
                                    >
                                        <ArrowLeft className="w-3.5 h-3.5" />
                                        <span>Back</span>
                                    </Button>
                                    <Button
                                        onClick={generatePreview}
                                        disabled={mappingIssues.length > 0}
                                    >
                                        <span>Generate Preview</span>
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 'review' && previewProfile && (
                        <div className="space-y-4 text-xs">
                            <div className="space-y-2">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <label className="text-[11px] text-neutral-500">
                                            Profile Name
                                        </label>
                                        <Input
                                            value={profileName}
                                            onChange={(e) => {
                                                setProfileName(e.target.value);
                                                setPreviewProfile({
                                                    ...previewProfile,
                                                    name: e.target.value.trim() || 'Blank Form Profile',
                                                });
                                            }}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <label className="text-[11px] text-neutral-500">
                                            Description
                                        </label>
                                        <Input
                                            value={description}
                                            placeholder="Optional"
                                            onChange={(e) => {
                                                setDescription(e.target.value);
                                                setPreviewProfile({
                                                    ...previewProfile,
                                                    description: e.target.value,
                                                });
                                            }}
                                        />
                                    </div>
                                </div>
                            </div>

                            {validationErrors.length > 0 && (
                                <div className="rounded-md border border-rose-200 bg-rose-50 p-3 space-y-1">
                                    <p className="font-semibold text-rose-800">
                                        The generated profile failed structural validation:
                                    </p>
                                    {validationErrors.map((item, i) => (
                                        <p key={i} className="text-[11px] text-rose-700">
                                            • {item}
                                        </p>
                                    ))}
                                </div>
                            )}

                            <div className="space-y-2">
                                <span className="font-semibold text-neutral-700">
                                    Generated Fields ({previewProfile.fields.length})
                                </span>
                                {previewProfile.fields.map((field) => (
                                    <div
                                        key={field.id}
                                        className="rounded-lg border border-neutral-200 p-3 space-y-1.5 bg-neutral-50/60"
                                    >
                                        <div className="flex items-center justify-between">
                                            <span className="font-bold text-neutral-900">
                                                {field.name}
                                                {field.required && (
                                                    <span className="text-rose-500"> *</span>
                                                )}
                                            </span>
                                            <span className="text-[10px] text-neutral-500 font-mono">
                                                {field.type} · {field.priority}
                                            </span>
                                        </div>
                                        <p className="text-[10px] text-neutral-500">{field.description}</p>
                                        {field.contentRules.labels.length > 0 && (
                                            <div className="space-y-0.5">
                                                <span className="text-[10px] font-semibold text-neutral-600">
                                                    Label aliases ({field.contentRules.labels.length}):
                                                </span>
                                                {field.contentRules.labels.map((labelText, i) => (
                                                    <p
                                                        key={i}
                                                        className="text-[10px] font-mono text-neutral-700 bg-white border border-neutral-200 rounded px-1.5 py-0.5 truncate"
                                                        title={labelText}
                                                    >
                                                        {labelText}
                                                    </p>
                                                ))}
                                            </div>
                                        )}
                                        {field.validation.formatRegex && (
                                            <p className="text-[10px] text-neutral-600">
                                                Validation regex:{' '}
                                                <code className="font-mono">{field.validation.formatRegex}</code>
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>

                            <p className="text-[10px] text-neutral-500">
                                Filename rules and AI are disabled in generated profiles —
                                values come from the form widgets themselves. You can refine
                                everything later in the profile editor after saving.
                            </p>

                            <div className="flex items-center justify-between pt-2 border-t border-neutral-200">
                                <Button
                                    variant="outline"
                                    onClick={() => setStep('map')}
                                    disabled={busy}
                                >
                                    <ArrowLeft className="w-3.5 h-3.5" />
                                    <span>Edit Mapping</span>
                                </Button>
                                <div className="flex items-center gap-2">
                                    {validationErrors.length === 0 && !error && (
                                        <span className="text-[11px] text-emerald-700 flex items-center gap-1">
                                            <CheckCircle2 className="w-3.5 h-3.5" />
                                            Ready to save
                                        </span>
                                    )}
                                    <Button onClick={handleCreate} disabled={busy}>
                                        {busy ? 'Validating…' : 'Create Profile'}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

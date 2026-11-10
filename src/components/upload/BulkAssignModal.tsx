/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ListChecks, RefreshCw, X } from "lucide-react";
import {
    BulkAssignmentFilterType,
    BulkAssignmentRequest,
    DocumentAssignment,
    ExtractionProfile,
} from "../../types/extraction";

interface BulkAssignModalProps {
    profiles: ExtractionProfile[];
    /** Assignment rows still eligible for a bulk sweep (pending documents). */
    documents: DocumentAssignment[];
    defaultProfileId?: string;
    onClose: () => void;
    /** Performs the API call; reject with an Error to keep the modal open. */
    onConfirm: (payload: BulkAssignmentRequest) => Promise<void>;
}

/**
 * Mirrors the backend's matcher: case-insensitive, and `*` is the only
 * wildcard (every other character is matched literally).
 */
export function matchesFilenameFilter(
    filename: string,
    filterType: BulkAssignmentFilterType,
    filterValue: string,
): boolean {
    const name = filename.toLowerCase();
    const value = filterValue.trim().toLowerCase();
    if (!value) return false;
    if (filterType === "exact_match") return name === value;
    const pattern = value
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`).test(name);
}

export const BulkAssignModal: React.FC<BulkAssignModalProps> = ({
    profiles,
    documents,
    defaultProfileId,
    onClose,
    onConfirm,
}) => {
    const [profileId, setProfileId] = useState(defaultProfileId ?? "");
    const [filterType, setFilterType] =
        useState<BulkAssignmentFilterType>("filename_pattern");
    const [filterValue, setFilterValue] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const matches = useMemo(
        () =>
            documents.filter((document) =>
                matchesFilenameFilter(document.filename, filterType, filterValue),
            ),
        [documents, filterType, filterValue],
    );

    const preservedManual = matches.filter(
        (document) => document.assignmentMethod === "manual",
    ).length;
    const selectedProfile = profiles.find((profile) => profile.id === profileId);
    const isClearing = profileId === "";
    const hasFilter = filterValue.trim().length > 0;

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !isSubmitting) onClose();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isSubmitting, onClose]);

    const handleConfirm = async () => {
        if (!hasFilter || isSubmitting) return;
        setIsSubmitting(true);
        setError(null);
        try {
            // The parent closes this modal on success, so nothing is set here.
            await onConfirm({
                profileId: isClearing ? null : profileId,
                filter: { type: filterType, value: filterValue.trim() },
            });
        } catch (err: unknown) {
            setError(
                err instanceof Error ? err.message : "Bulk assignment failed",
            );
            setIsSubmitting(false);
        }
    };

    const confirmLabel =
        matches.length === 0
            ? "Confirm"
            : isClearing
                ? `Clear ${matches.length} document${matches.length === 1 ? "" : "s"}`
                : `Assign ${matches.length} document${matches.length === 1 ? "" : "s"}`;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-assign-title"
            onClick={() => {
                if (!isSubmitting) onClose();
            }}
        >
            <div
                className="w-full max-w-md bg-white rounded-xl border border-neutral-200 shadow-xl p-5 space-y-4 animate-in fade-in"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <span className="w-8 h-8 rounded-lg bg-neutral-900 text-white flex items-center justify-center shrink-0">
                            <ListChecks className="w-4 h-4" />
                        </span>
                        <div>
                            <h3
                                id="bulk-assign-title"
                                className="text-sm font-bold text-neutral-900"
                            >
                                Bulk assign profile
                            </h3>
                            <p className="text-[11px] text-neutral-500">
                                Applies to pending documents that match the filename filter.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={isSubmitting}
                        aria-label="Close bulk assignment"
                        className="p-1 text-neutral-400 hover:text-neutral-700 rounded transition-colors disabled:opacity-50"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="space-y-3">
                    <div className="space-y-1">
                        <label
                            htmlFor="bulk-assign-profile"
                            className="text-[11px] font-semibold text-neutral-700"
                        >
                            Profile
                        </label>
                        <select
                            id="bulk-assign-profile"
                            value={profileId}
                            onChange={(event) => setProfileId(event.target.value)}
                            disabled={isSubmitting}
                            className="w-full px-2 py-1.5 text-xs bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900 disabled:opacity-50"
                        >
                            <option value="">Clear assignment (no profile)</option>
                            {profiles.map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                    {profile.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                            <label
                                htmlFor="bulk-assign-filter-type"
                                className="text-[11px] font-semibold text-neutral-700"
                            >
                                Match on
                            </label>
                            <select
                                id="bulk-assign-filter-type"
                                value={filterType}
                                onChange={(event) =>
                                    setFilterType(event.target.value as BulkAssignmentFilterType)
                                }
                                disabled={isSubmitting}
                                className="w-full px-2 py-1.5 text-xs bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900 disabled:opacity-50"
                            >
                                <option value="filename_pattern">Filename pattern</option>
                                <option value="exact_match">Exact filename</option>
                            </select>
                        </div>
                        <div className="space-y-1">
                            <label
                                htmlFor="bulk-assign-filter-value"
                                className="text-[11px] font-semibold text-neutral-700"
                            >
                                Filename
                            </label>
                            <input
                                id="bulk-assign-filter-value"
                                type="text"
                                value={filterValue}
                                onChange={(event) => setFilterValue(event.target.value)}
                                disabled={isSubmitting}
                                placeholder={
                                    filterType === "filename_pattern"
                                        ? "e.g., W8*"
                                        : "e.g., form_123.pdf"
                                }
                                className="w-full px-2 py-1.5 text-xs bg-white border border-neutral-300 rounded-md focus:outline-hidden focus:ring-2 focus:ring-neutral-900 disabled:opacity-50"
                            />
                        </div>
                    </div>

                    <div className="p-3 rounded-lg border border-neutral-200 bg-neutral-50 text-[11px] text-neutral-700 space-y-1">
                        <div className="flex items-center gap-1.5 font-semibold text-neutral-900">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
                            <span>
                                {matches.length} of {documents.length} pending document
                                {documents.length === 1 ? "" : "s"} match
                            </span>
                        </div>
                        {matches.length > 0 && (
                            <p>
                                {isClearing
                                    ? "Their profile will be cleared and they will be reported instead of processed."
                                    : `They will be assigned to ${selectedProfile?.name ?? "the selected profile"}.`}
                            </p>
                        )}
                        {preservedManual > 0 && (
                            <p className="text-amber-700">
                                {preservedManual} manual override
                                {preservedManual === 1 ? "" : "s"} in the matches will be
                                preserved.
                            </p>
                        )}
                        {hasFilter && matches.length === 0 && (
                            <p className="text-amber-700">
                                No document matches this filter.
                            </p>
                        )}
                    </div>

                    {error && (
                        <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-md text-[11px] text-rose-800 flex items-center gap-2">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0 text-rose-600" />
                            <span>{error}</span>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 pt-3 border-t border-neutral-200">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={isSubmitting}
                        className="px-3 py-1.5 text-xs font-semibold text-neutral-700 bg-white hover:bg-neutral-100 border border-neutral-300 rounded-md transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!hasFilter || isSubmitting}
                        className="flex items-center gap-2 px-4 py-1.5 text-xs font-bold text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isSubmitting && (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        )}
                        <span>{isSubmitting ? "Applying..." : confirmLabel}</span>
                    </button>
                </div>
            </div>
        </div>
    );
};

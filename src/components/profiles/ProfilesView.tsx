/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  Plus,
  Trash2,
  Copy,
  Save,
  Sliders,
  Check,
  FileText,
  Code,
  Download,
  Upload,
  AlertCircle,
  Pencil,
  ArrowRight,
  FilePlus2,
} from 'lucide-react';
import {
  ExtractionProfile,
  FieldDefinition,
  SourcePriority,
} from '../../types/extraction';
import { DEFAULT_PROFILES } from '../../data/defaultProfiles';
import { extractFromFilename } from '../../services/extractionEngine';
import { getApiErrorMessage, testOllamaConnection } from '../../services/apiClient';
import { BlankFormProfileWizard } from './BlankFormProfileWizard';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface ProfilesViewProps {
  profiles: ExtractionProfile[];
  onSaveProfile: (profile: ExtractionProfile) => void;
  onDeleteProfile: (profileId: string) => void;
  onDuplicateProfile: (profile: ExtractionProfile) => void;
}

const profileMetadataSchema = z.object({
  name: z.string().trim().min(1, 'Enter a profile name.').max(200, 'Profile names must be 200 characters or fewer.'),
});

type ProfileMetadata = z.infer<typeof profileMetadataSchema>;

export const ProfilesView: React.FC<ProfilesViewProps> = ({
  profiles,
  onSaveProfile,
  onDeleteProfile,
  onDuplicateProfile,
}) => {
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    profiles[0]?.id || DEFAULT_PROFILES[0].id
  );
  const [isEditing, setIsEditing] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const hasLoadedProfiles = useRef(profiles.length > 0);

  // Working copy for editor
  const [currentProfile, setCurrentProfile] = useState<ExtractionProfile>(
    profiles.find((p) => p.id === selectedProfileId) ||
    profiles[0] ||
    DEFAULT_PROFILES[0]
  );
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ProfileMetadata>({
    resolver: zodResolver(profileMetadataSchema),
    defaultValues: { name: profiles[0]?.name || '' },
  });

  // Field selected for editing within profile
  const [activeFieldId, setActiveFieldId] = useState<string>(
    currentProfile?.fields[0]?.id || ''
  );

  // Live test input
  const [testFilename, setTestFilename] = useState<string>(
    '2026-00125-JUAN-DELA-CRUZ-ACTIVE.pdf'
  );
  const [ollamaTestState, setOllamaTestState] = useState<{
    loading: boolean;
    message: string;
    models: string[];
  }>({ loading: false, message: '', models: [] });
  // Why a requested extraction-method switch was refused.
  const [methodWarning, setMethodWarning] = useState('');

  const aiSettings = currentProfile.aiSettings || {
    enabled: false,
    baseUrl: 'http://127.0.0.1:11434',
    model: '',
    timeoutSeconds: 120,
    contextSize: 16384,
    strategy: 'review' as const,
    allowCloudModels: false,
  };

  useEffect(() => {
    if (profiles.length === 0) {
      return;
    }

    const firstProfileLoad = !hasLoadedProfiles.current;
    hasLoadedProfiles.current = true;
    if (isEditing) {
      return;
    }

    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    const nextProfile =
      selected ||
      (firstProfileLoad || currentProfile.id !== selectedProfileId
        ? profiles[0]
        : undefined);
    if (nextProfile) {
      setSelectedProfileId(nextProfile.id);
      setCurrentProfile(JSON.parse(JSON.stringify(nextProfile)));
      setActiveFieldId((activeFieldId) =>
        nextProfile.fields.some((field) => field.id === activeFieldId)
          ? activeFieldId
          : nextProfile.fields[0]?.id || ''
      );
    }
  }, [profiles, selectedProfileId, currentProfile.id, isEditing]);

  useEffect(() => {
    reset({ name: currentProfile?.name || '' });
  }, [currentProfile?.id, currentProfile?.name, reset]);

  const handleSelectProfile = (id: string) => {
    setSelectedProfileId(id);
    const found = profiles.find((p) => p.id === id);
    if (found) {
      setCurrentProfile(JSON.parse(JSON.stringify(found)));
      setActiveFieldId(found.fields[0]?.id || '');
    }
  };

  const handleCreateNew = () => {
    const newProfile: ExtractionProfile = {
      id: `profile-${Date.now()}`,
      name: 'Custom Document Profile',
      description: 'User-configured extraction rules for custom PDF forms.',
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ocrSettings: {
        enabledFallback: true,
        autoDetectScanned: true,
        minTextLengthThreshold: 45,
        language: 'eng',
        quality: 'standard',
      },
      extractionSettings: { labelSimilarityThreshold: 0.82 },
      fields: [
        {
          id: 'field_1',
          name: 'Reference Code',
          label: 'Reference Code',
          type: 'text',
          required: true,
          filenameRules: {
            enabled: true,
            patterns: ['^([A-Z0-9-]+)'],
            captureGroup: 1,
            caseInsensitive: true,
          },
          contentRules: {
            enabled: true,
            labels: ['Reference:', 'Ref:', 'Code:'],
            positionHint: 'after_label',
          },
          priority: 'pdf_first',
          normalization: {
            trim: true,
            caseTransform: 'uppercase',
            removeExtraSpaces: true,
          },
          validation: {
            minLength: 3,
          },
        },
      ],
    };
    setCurrentProfile(newProfile);
    setSelectedProfileId(newProfile.id);
    setActiveFieldId('field_1');
    setIsEditing(true);
  };

  const handleAddField = () => {
    const newFieldId = `field_${Date.now()}`;
    const newField: FieldDefinition = {
      id: newFieldId,
      name: 'New Field',
      label: 'New Field',
      type: 'text',
      required: false,
      filenameRules: {
        enabled: false,
        patterns: [],
        captureGroup: 1,
        caseInsensitive: true,
      },
      contentRules: {
        enabled: true,
        labels: ['Field Label:'],
        positionHint: 'after_label',
      },
      priority: 'pdf_first',
      normalization: {
        trim: true,
        caseTransform: 'none',
        removeExtraSpaces: true,
      },
      validation: {},
    };

    setCurrentProfile({
      ...currentProfile,
      fields: [...currentProfile.fields, newField],
    });
    setActiveFieldId(newFieldId);
  };

  const handleDeleteField = (fieldId: string) => {
    if (currentProfile.fields.length <= 1) {
      alert('A profile must have at least one field.');
      return;
    }
    const updated = currentProfile.fields.filter((f) => f.id !== fieldId);
    setCurrentProfile({
      ...currentProfile,
      fields: updated,
    });
    setActiveFieldId(updated[0]?.id || '');
  };

  const handleSave = handleSubmit((values) => {
    onSaveProfile({
      ...currentProfile,
      name: values.name,
      aiSettings,
      updatedAt: new Date().toISOString(),
    });
    setIsEditing(false);
  });

  const handleTestOllama = async () => {
    setOllamaTestState({ loading: true, message: '', models: [] });
    try {
      const models = await testOllamaConnection(
        aiSettings.baseUrl,
        aiSettings.model,
        aiSettings.timeoutSeconds,
        aiSettings.allowCloudModels === true
      );
      setOllamaTestState({
        loading: false,
        message: `Structured generation succeeded. Found ${models.length} installed model(s).`,
        models,
      });
    } catch (error) {
      setOllamaTestState({
        loading: false,
        message: getApiErrorMessage(error),
        models: [],
      });
    }
  };

  const activeField = currentProfile.fields.find((f) => f.id === activeFieldId);

  const updateActiveField = (updates: Partial<FieldDefinition>) => {
    if (!activeField) return;
    const updatedFields = currentProfile.fields.map((f) =>
      f.id === activeFieldId ? { ...f, ...updates } : f
    );
    setCurrentProfile({
      ...currentProfile,
      fields: updatedFields,
    });
  };

  // Test live regex against active field
  const liveRegexResult = activeField
    ? extractFromFilename(testFilename, activeField)
    : null;

  return (
    <div className="max-w-7xl mx-auto space-y-6">

      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-neutral-200">
        <div>
          <h2 className="text-xl font-bold text-neutral-900 tracking-tight">
            Extraction Profiles Manager
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Define, customize, test, and save field parsing rules without touching source code.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setIsWizardOpen(true)}
            title="Upload an empty PDF form and build a profile from its fields"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            <span>From Blank Form</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleCreateNew}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create New Profile</span>
          </Button>
          <Button type="button" onClick={handleSave}>
            <Save className="w-3.5 h-3.5" />
            <span>Save Profile</span>
          </Button>
        </div>
      </div>

      {/* Main Grid: Left Profile List & General Settings, Right Field Rules Editor */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Left Column: Profiles List & General Profile Settings */}
        <div className="lg:col-span-4 space-y-5">
          <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-xs space-y-4">
            <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider block">
              Saved Profiles
            </span>

            <div className="space-y-2">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  onClick={() => handleSelectProfile(p.id)}
                  className={`p-3 rounded-lg border text-xs cursor-pointer transition-colors ${p.id === currentProfile.id
                    ? 'border-neutral-900 bg-neutral-50 shadow-xs'
                    : 'border-neutral-200 hover:bg-neutral-50/60'
                    }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-neutral-900">{p.name}</span>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      v{p.version}
                    </span>
                  </div>
                  <p className="text-neutral-500 text-[11px] mt-1 line-clamp-2">
                    {p.description}
                  </p>
                  <div className="flex items-center justify-between pt-2 mt-2 border-t border-neutral-200/70 text-[11px] text-neutral-500">
                    <span>{p.fields.length} target fields</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDuplicateProfile(p);
                        }}
                        className="hover:text-neutral-900"
                        title="Duplicate Profile"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                      {profiles.length > 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteProfile(p.id);
                          }}
                          className="hover:text-rose-600"
                          title="Delete Profile"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Profile Metadata Editor */}
          <div className="bg-white rounded-xl border border-neutral-200 p-4 shadow-xs space-y-3 text-xs">
            <span className="font-semibold text-neutral-700 block">
              Profile Metadata, OCR &amp; Local AI
            </span>

            <div className="space-y-1">
              <label className="text-[11px] text-neutral-500">Profile Name</label>
              <Input type="text" {...register('name')} />
              {errors.name && (
                <p role="alert" className="text-[11px] text-rose-700">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-neutral-500">Description</label>
              <textarea
                value={currentProfile.description}
                onChange={(e) =>
                  setCurrentProfile({ ...currentProfile, description: e.target.value })
                }
                rows={2}
                className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs"
              />
            </div>

            <div className="pt-2 border-t border-neutral-200 space-y-2">
              <span className="font-semibold text-neutral-700 block">
                Extraction Accuracy &amp; OCR Parameters
              </span>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={currentProfile.ocrSettings.enabledFallback}
                  onChange={(e) =>
                    setCurrentProfile({
                      ...currentProfile,
                      ocrSettings: {
                        ...currentProfile.ocrSettings,
                        enabledFallback: e.target.checked,
                      },
                    })
                  }
                  className="rounded text-neutral-900 border-neutral-300"
                />
                <span className="text-neutral-700">Enable Tesseract OCR Fallback</span>
              </label>

              <div className="space-y-1">
                <label className="text-[11px] text-neutral-500">
                  Sparse Page Threshold (Characters)
                </label>
                <input
                  type="number"
                  value={currentProfile.ocrSettings.minTextLengthThreshold}
                  onChange={(e) =>
                    setCurrentProfile({
                      ...currentProfile,
                      ocrSettings: {
                        ...currentProfile.ocrSettings,
                        minTextLengthThreshold: parseInt(e.target.value, 10) || 0,
                      },
                    })
                  }
                  className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs font-mono"
                />
                <p className="text-[10px] text-neutral-400">
                  Pages with fewer native text characters are selected for OCR. Scanned-image pages may also be selected.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-neutral-500">
                  OCR Resolution
                </label>
                <select
                  value={currentProfile.ocrSettings.quality || 'standard'}
                  onChange={(e) =>
                    setCurrentProfile({
                      ...currentProfile,
                      ocrSettings: {
                        ...currentProfile.ocrSettings,
                        quality: e.target.value as 'standard' | 'high',
                      },
                    })
                  }
                  className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs bg-white"
                >
                  <option value="standard">Standard (faster)</option>
                  <option value="high">High (more detail, slower)</option>
                </select>
                <p className="text-[10px] text-neutral-400">
                  High resolution can help with small or faint scanned text; it uses more time and memory.
                </p>
              </div>

              <div className="pt-2 border-t border-neutral-200 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={aiSettings.enabled}
                    onChange={(e) => {
                      setOllamaTestState({ loading: false, message: '', models: [] });
                      setCurrentProfile({
                        ...currentProfile,
                        aiSettings: { ...aiSettings, enabled: e.target.checked },
                      });
                    }}
                    className="rounded text-neutral-900 border-neutral-300"
                  />
                  <span className="font-semibold text-neutral-700">
                    Enable AI (Ollama)
                  </span>
                </label>
                <p className="text-[10px] text-neutral-400">
                  AI receives page, row, and column context from native text and OCR. Values are accepted only with matching on-page label and value evidence; disagreements are flagged for review.
                </p>
                {aiSettings.enabled && (
                  <>
                    <label className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-[10px] text-amber-900">
                      <input
                        type="checkbox"
                        checked={aiSettings.allowCloudModels === true}
                        onChange={(e) => {
                          setOllamaTestState({ loading: false, message: '', models: [] });
                          setCurrentProfile({
                            ...currentProfile,
                            aiSettings: {
                              ...aiSettings,
                              allowCloudModels: e.target.checked,
                            },
                          });
                        }}
                        className="mt-0.5 rounded text-neutral-900 border-neutral-300"
                      />
                      <span>
                        Allow Ollama cloud models. When a cloud-tagged model (for example, <code>:cloud</code>) is selected, document text and extraction labels are sent to Ollama&apos;s cloud service. Use local models to keep documents on this machine.
                      </span>
                    </label>
                    <div className="space-y-1">
                      <label className="text-[11px] text-neutral-500">
                        AI Extraction Strategy
                      </label>
                      <select
                        value={aiSettings.strategy || 'review'}
                        onChange={(e) =>
                          setCurrentProfile({
                            ...currentProfile,
                            aiSettings: {
                              ...aiSettings,
                              strategy: e.target.value as 'review' | 'fallback',
                            },
                          })
                        }
                        className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs bg-white"
                      >
                        <option value="review">
                          Cross-check every configured field (more thorough)
                        </option>
                        <option value="selective">
                          Review uncertain or conflicting candidates
                        </option>
                        <option value="fallback">
                          Fill missing fields only (faster)
                        </option>
                      </select>
                      <p className="text-[10px] text-neutral-400">
                        Selective review calls AI for missing, low-scoring, invalid, ambiguous, or conflicting candidates. Its score threshold is heuristic, so verify AI-only values and disagreements.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-neutral-500">
                        Ollama URL
                      </label>
                      <input
                        type="url"
                        value={aiSettings.baseUrl}
                        onChange={(e) =>
                          setCurrentProfile({
                            ...currentProfile,
                            aiSettings: { ...aiSettings, baseUrl: e.target.value },
                          })
                        }
                        placeholder="http://127.0.0.1:11434"
                        className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-neutral-500">
                        Ollama Model
                      </label>
                      <input
                        type="text"
                        value={aiSettings.model}
                        onChange={(e) =>
                          setCurrentProfile({
                            ...currentProfile,
                            aiSettings: { ...aiSettings, model: e.target.value },
                          })
                        }
                        placeholder="e.g. llama3.2"
                        className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-neutral-500">
                        Model Context Size (tokens)
                      </label>
                      <input
                        type="number"
                        min={2048}
                        max={32768}
                        step={1024}
                        value={aiSettings.contextSize || 16384}
                        onChange={(e) =>
                          setCurrentProfile({
                            ...currentProfile,
                            aiSettings: {
                              ...aiSettings,
                              contextSize: Math.min(
                                32768,
                                Math.max(2048, Number(e.target.value) || 16384)
                              ),
                            },
                          })
                        }
                        className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs font-mono"
                      />
                      <p className="text-[10px] text-neutral-400">
                        Larger documents may need a larger context and more memory. The configured model must support this size.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-neutral-500">
                        Request Timeout (seconds)
                      </label>
                      <input
                        type="number"
                        min={5}
                        max={600}
                        value={aiSettings.timeoutSeconds}
                        onChange={(e) =>
                          setCurrentProfile({
                            ...currentProfile,
                            aiSettings: {
                              ...aiSettings,
                              timeoutSeconds: Math.min(
                                600,
                                Math.max(5, Number(e.target.value) || 120)
                              ),
                            },
                          })
                        }
                        className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs font-mono"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleTestOllama}
                      disabled={
                        ollamaTestState.loading || !aiSettings.model.trim()
                      }
                    >
                      {ollamaTestState.loading
                        ? 'Testing model generation...'
                        : 'Test Ollama Model'}
                    </Button>
                    {ollamaTestState.message && (
                      <p
                        role="status"
                        className={`text-[10px] ${ollamaTestState.models.length
                          ? 'text-emerald-700'
                          : 'text-rose-700'
                          }`}
                      >
                        {ollamaTestState.message}
                      </p>
                    )}
                    {ollamaTestState.models.length > 0 && (
                      <p className="text-[10px] text-neutral-500">
                        Installed: {ollamaTestState.models.join(', ')}
                      </p>
                    )}
                  </>
                )}
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="label-similarity-threshold"
                  className="text-[11px] text-neutral-500"
                >
                  Label Match Strictness
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="label-similarity-threshold"
                    type="range"
                    min={70}
                    max={100}
                    step={1}
                    value={Math.round(
                      (currentProfile.extractionSettings
                        ?.labelSimilarityThreshold ?? 0.82) * 100
                    )}
                    onChange={(e) =>
                      setCurrentProfile({
                        ...currentProfile,
                        extractionSettings: {
                          ...currentProfile.extractionSettings,
                          labelSimilarityThreshold:
                            Number(e.target.value) / 100,
                        },
                      })
                    }
                    className="flex-1"
                  />
                  <span className="w-10 text-right text-xs font-mono">
                    {Math.round(
                      (currentProfile.extractionSettings
                        ?.labelSimilarityThreshold ?? 0.82) * 100
                    )}%
                  </span>
                </div>
                <p className="text-[10px] text-neutral-400">
                  Higher values reduce false label matches; lower values tolerate OCR errors but may match the wrong label. Exact matches are unaffected.
                </p>
              </div>

              <div className="pt-2 border-t border-neutral-200 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={
                      currentProfile.extractionSettings?.firstPageOnly === true
                    }
                    onChange={(e) =>
                      setCurrentProfile({
                        ...currentProfile,
                        extractionSettings: {
                          labelSimilarityThreshold:
                            currentProfile.extractionSettings
                              ?.labelSimilarityThreshold ?? 0.82,
                          ...currentProfile.extractionSettings,
                          firstPageOnly: e.target.checked,
                        },
                      })
                    }
                    className="rounded text-neutral-900 border-neutral-300"
                  />
                  <span className="font-semibold text-neutral-700">
                    Read First Page Only
                  </span>
                </label>
                <p className="text-[10px] text-neutral-400">
                  For multi-page PDFs whose form is page 1 (for example, a W-9 followed by IRS instructions). Later pages are ignored by native text, form fields, OCR, and AI.
                </p>
              </div>

              <div className="pt-2 border-t border-neutral-200 space-y-2">
                <label
                  htmlFor="extraction-method"
                  className="text-[11px] text-neutral-500"
                >
                  Extraction Method
                </label>
                <select
                  id="extraction-method"
                  value={currentProfile.extractionSettings?.method ?? 'label'}
                  onChange={(e) => {
                    const method = e.target.value === 'roi' ? 'roi' : 'label';
                    const schema = currentProfile.extractionSettings?.annotationSchema;
                    if (method === 'roi' && !(schema?.pages?.length)) {
                      // Refuse the switch rather than saving 'roi' with nothing
                      // to read: an empty schema returns blank values for every
                      // field, which reads as an extraction bug instead of the
                      // configuration error it is.
                      setMethodWarning(
                        'ROI extraction needs an annotation schema for this form. Annotate the blank form first; the profile stays on label matching.'
                      );
                      return;
                    }
                    setMethodWarning('');
                    setCurrentProfile({
                      ...currentProfile,
                      extractionSettings: {
                        ...currentProfile.extractionSettings,
                        labelSimilarityThreshold:
                          currentProfile.extractionSettings
                            ?.labelSimilarityThreshold ?? 0.82,
                        method,
                      },
                    });
                  }}
                  className="w-full rounded border border-neutral-300 px-2 py-1 text-xs"
                >
                  <option value="label">Label matching (default)</option>
                  <option value="roi">Annotated regions (ROI)</option>
                </select>
                <p className="text-[10px] text-neutral-400">
                  Label matching finds each value next to its printed label. ROI reads only the boxes drawn on the blank form and records which source supplied each value.
                </p>
                {methodWarning && (
                  <p className="text-[10px] text-rose-600">{methodWarning}</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Field Extraction Rules & Interactive Regex Tester */}
        <div className="lg:col-span-8 space-y-5">
          <div className="bg-white rounded-xl border border-neutral-200 p-6 shadow-xs space-y-6">

            {/* Field Picker Header */}
            <div className="flex items-center justify-between pb-3 border-b border-neutral-200">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-neutral-700" />
                <h3 className="text-sm font-bold text-neutral-900">
                  Configure Extraction Fields
                </h3>
              </div>
              <button
                onClick={handleAddField}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-800 bg-neutral-100 hover:bg-neutral-200 rounded border border-neutral-200"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Field</span>
              </button>
            </div>

            {/* Field Tabs */}
            <div className="flex gap-2 overflow-x-auto pb-2 border-b border-neutral-100 scrollbar-thin">
              {currentProfile.fields.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setActiveFieldId(f.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors flex items-center gap-2 ${activeFieldId === f.id
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-50 text-neutral-700 hover:bg-neutral-100 border border-neutral-200'
                    }`}
                >
                  <span>{f.name}</span>
                  {f.required && <span className="text-rose-400 font-bold">*</span>}
                </button>
              ))}
            </div>

            {activeField ? (
              <div className="space-y-6 text-xs">

                {/* Field Basic Attributes */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-700">Field Name</label>
                    <input
                      type="text"
                      value={activeField.name}
                      onChange={(e) => updateActiveField({ name: e.target.value })}
                      className="w-full px-2.5 py-1.5 border border-neutral-300 rounded font-medium"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-700">Field Type</label>
                    <select
                      value={activeField.type}
                      onChange={(e) =>
                        updateActiveField({
                          type: e.target.value as FieldDefinition['type'],
                        })
                      }
                      className="w-full px-2.5 py-1.5 border border-neutral-300 rounded"
                    >
                      <option value="text">Text (General)</option>
                      <option value="date">Date (Standardized)</option>
                      <option value="status">Status / Enum</option>
                      <option value="number">Numeric</option>
                      <option value="email">Email</option>
                      <option value="phone">Phone / Contact</option>
                      <option value="address">Address</option>
                      <option value="checkbox">Checkbox (True/False)</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-neutral-700">Source Priority</label>
                    <select
                      value={activeField.priority}
                      onChange={(e) =>
                        updateActiveField({
                          priority: e.target.value as SourcePriority,
                        })
                      }
                      className="w-full px-2.5 py-1.5 border border-neutral-300 rounded"
                    >
                      <option value="pdf_first">PDF Content First</option>
                      <option value="filename_first">Filename First</option>
                      <option value="strict_match">Strict Match (Flag Any Mismatch)</option>
                    </select>
                  </div>
                </div>

                {/* Section A: Filename Regex Extraction Rules */}
                <div className="p-4 rounded-lg border border-neutral-200 bg-neutral-50/50 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 cursor-pointer font-bold text-neutral-900">
                      <input
                        type="checkbox"
                        checked={activeField.filenameRules.enabled}
                        onChange={(e) =>
                          updateActiveField({
                            filenameRules: {
                              ...activeField.filenameRules,
                              enabled: e.target.checked,
                            },
                          })
                        }
                        className="rounded text-neutral-900 border-neutral-300"
                      />
                      <span>Filename Regex Extraction</span>
                    </label>

                    <label className="flex items-center gap-1.5 text-neutral-600">
                      <input
                        type="checkbox"
                        checked={activeField.filenameRules.caseInsensitive}
                        onChange={(e) =>
                          updateActiveField({
                            filenameRules: {
                              ...activeField.filenameRules,
                              caseInsensitive: e.target.checked,
                            },
                          })
                        }
                        className="rounded text-neutral-900 border-neutral-300"
                      />
                      <span>Case Insensitive (i)</span>
                    </label>
                  </div>

                  {activeField.filenameRules.enabled && (
                    <div className="space-y-3 pt-2">
                      <div className="space-y-1">
                        <label className="text-[11px] text-neutral-600">
                          Regex Patterns (One per line, tried in sequence)
                        </label>
                        <textarea
                          rows={2}
                          value={activeField.filenameRules.patterns.join('\n')}
                          onChange={(e) =>
                            updateActiveField({
                              filenameRules: {
                                ...activeField.filenameRules,
                                patterns: e.target.value.split('\n').filter(Boolean),
                              },
                            })
                          }
                          placeholder="e.g. ^(\d{4}-\d+) or \d+-([A-Z\s-]+)-"
                          className="w-full px-2.5 py-1.5 border border-neutral-300 rounded font-mono text-xs bg-white"
                        />
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] text-neutral-600">Capture Group Index:</label>
                          <input
                            type="number"
                            min={0}
                            max={5}
                            value={activeField.filenameRules.captureGroup}
                            onChange={(e) =>
                              updateActiveField({
                                filenameRules: {
                                  ...activeField.filenameRules,
                                  captureGroup: parseInt(e.target.value, 10) || 1,
                                },
                              })
                            }
                            className="w-16 px-2 py-1 border border-neutral-300 rounded font-mono text-xs bg-white text-center"
                          />
                        </div>
                      </div>

                      {/* Live Regex Interactive Tester Box */}
                      <div className="p-3 bg-neutral-900 text-neutral-200 rounded-md space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-bold text-white">Live Filename Tester</span>
                          <span className="text-neutral-400">Type test filename below:</span>
                        </div>
                        <input
                          type="text"
                          value={testFilename}
                          onChange={(e) => setTestFilename(e.target.value)}
                          className="w-full px-2.5 py-1 rounded bg-neutral-800 text-emerald-300 font-mono text-xs border border-neutral-700"
                        />
                        <div className="flex items-center gap-2 pt-1 text-[11px]">
                          <span className="text-neutral-400">Captured Value:</span>
                          {liveRegexResult?.value ? (
                            <span className="font-bold text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded font-mono">
                              &quot;{liveRegexResult.value}&quot;
                            </span>
                          ) : (
                            <span className="text-rose-400 italic font-mono">No match</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Section B: PDF Content Extraction Rules */}
                <div className="p-4 rounded-lg border border-neutral-200 bg-neutral-50/50 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer font-bold text-neutral-900">
                    <input
                      type="checkbox"
                      checked={activeField.contentRules.enabled}
                      onChange={(e) =>
                        updateActiveField({
                          contentRules: {
                            ...activeField.contentRules,
                            enabled: e.target.checked,
                          },
                        })
                      }
                      className="rounded text-neutral-900 border-neutral-300"
                    />
                    <span>PDF Content Extraction Rules</span>
                  </label>

                  {activeField.contentRules.enabled && (
                    <div className="space-y-3 pt-2">
                      <div className="space-y-1">
                        <label className="text-[11px] text-neutral-600">
                          Target Field Labels &amp; Aliases (one per line)
                        </label>
                        <textarea
                          rows={3}
                          value={activeField.contentRules.labels.join('\n')}
                          onChange={(e) =>
                            updateActiveField({
                              contentRules: {
                                ...activeField.contentRules,
                                labels: e.target.value
                                  .split(/\r?\n/)
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              },
                            })
                          }
                          placeholder={'FULL NAME:\nApplicant Name:\nName:'}
                          className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs bg-white font-mono"
                        />
                        <p className="text-[10px] text-neutral-400">
                          Enter each label or alias on its own line. If instructions share the label's printed line, include them in the label so they are not captured as the value.
                        </p>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[11px] text-neutral-600">
                          Content Regex Patterns (Optional fallback)
                        </label>
                        <input
                          type="text"
                          value={(activeField.contentRules.regexPatterns || []).join(', ')}
                          onChange={(e) =>
                            updateActiveField({
                              contentRules: {
                                ...activeField.contentRules,
                                regexPatterns: e.target.value
                                  .split(',')
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              },
                            })
                          }
                          placeholder="e.g. Reference\s*#?[:\s]*([0-9-]+)"
                          className="w-full px-2.5 py-1.5 border border-neutral-300 rounded text-xs bg-white font-mono"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Section C: Normalization & Validation */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Normalization */}
                  <div className="p-3.5 rounded-lg border border-neutral-200 bg-white space-y-2">
                    <span className="font-semibold text-neutral-800 block">Normalization</span>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={activeField.normalization.trim}
                        onChange={(e) =>
                          updateActiveField({
                            normalization: {
                              ...activeField.normalization,
                              trim: e.target.checked,
                            },
                          })
                        }
                        className="rounded text-neutral-900 border-neutral-300"
                      />
                      <span>Trim leading/trailing whitespace</span>
                    </label>

                    <div className="space-y-1 pt-1">
                      <label className="text-[11px] text-neutral-500">Case Transformation</label>
                      <select
                        value={activeField.normalization.caseTransform}
                        onChange={(e) =>
                          updateActiveField({
                            normalization: {
                              ...activeField.normalization,
                              caseTransform: e.target.value as FieldDefinition['normalization']['caseTransform'],
                            },
                          })
                        }
                        className="w-full px-2 py-1 border border-neutral-300 rounded"
                      >
                        <option value="none">As-Is (No change)</option>
                        <option value="uppercase">UPPERCASE</option>
                        <option value="lowercase">lowercase</option>
                        <option value="titlecase">Title Case</option>
                      </select>
                    </div>

                    {activeField.type === 'date' && (
                      <>
                        <div className="space-y-1 pt-1">
                          <label className="text-[11px] text-neutral-500">Date Format</label>
                          <select
                            value={activeField.normalization.dateFormat || 'as_is'}
                            onChange={(e) =>
                              updateActiveField({
                                normalization: {
                                  ...activeField.normalization,
                                  dateFormat: e.target.value as FieldDefinition['normalization']['dateFormat'],
                                },
                              })
                            }
                            className="w-full px-2 py-1 border border-neutral-300 rounded"
                          >
                            <option value="as_is">Keep as-is (no date parsing)</option>
                            <option value="YYYY-MM-DD">YYYY-MM-DD (ISO)</option>
                            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                            <option value="MM-DD-YYYY">MM-DD-YYYY</option>
                          </select>
                        </div>

                        <div className="space-y-1 pt-1">
                          <label className="text-[11px] text-neutral-500">
                            Ambiguous Date Order (day/month vs month/day)
                          </label>
                          <select
                            value={activeField.normalization.dateOrder || 'month_first'}
                            onChange={(e) =>
                              updateActiveField({
                                normalization: {
                                  ...activeField.normalization,
                                  dateOrder: e.target.value as FieldDefinition['normalization']['dateOrder'],
                                },
                              })
                            }
                            className="w-full px-2 py-1 border border-neutral-300 rounded"
                          >
                            <option value="month_first">Month first (US, default)</option>
                            <option value="day_first">Day first (EU)</option>
                          </select>
                          <p className="text-[10px] text-neutral-400">
                            Applied when a Date Format above is set. Only used when both
                            readings are valid, e.g. 03/04/2026; an explicit DD/MM/YYYY
                            format overrides this.
                          </p>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Validation */}
                  <div className="p-3.5 rounded-lg border border-neutral-200 bg-white space-y-2">
                    <span className="font-semibold text-neutral-800 block">Validation Criteria</span>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={activeField.required}
                        onChange={(e) => updateActiveField({ required: e.target.checked })}
                        className="rounded text-neutral-900 border-neutral-300"
                      />
                      <span className="font-medium text-rose-700">Required Field</span>
                    </label>

                    <div className="space-y-1 pt-1">
                      <label className="text-[11px] text-neutral-500">
                        Allowed Values (Comma-separated for Status/Enum)
                      </label>
                      <input
                        type="text"
                        value={(activeField.validation.allowedValues || []).join(', ')}
                        onChange={(e) =>
                          updateActiveField({
                            validation: {
                              ...activeField.validation,
                              allowedValues: e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean),
                            },
                          })
                        }
                        placeholder="e.g. ACTIVE, INACTIVE, PENDING"
                        className="w-full px-2 py-1 border border-neutral-300 rounded font-mono text-xs"
                      />
                    </div>
                  </div>
                </div>

                {/* Delete Field Button */}
                <div className="pt-2 flex justify-end">
                  <button
                    onClick={() => handleDeleteField(activeField.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-rose-700 hover:text-rose-900 hover:bg-rose-50 rounded transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Field &quot;{activeField.name}&quot;</span>
                  </button>
                </div>

              </div>
            ) : null}

          </div>
        </div>

      </div>

      {isWizardOpen && (
        <BlankFormProfileWizard
          existingProfileNames={profiles.map((profile) => profile.name)}
          onClose={() => setIsWizardOpen(false)}
          onProfileReady={(profile) => {
            setIsWizardOpen(false);
            // Reuse the regular save pathway so the generated profile is
            // created through the same API and refresh logic as any other.
            onSaveProfile(profile);
          }}
        />
      )}
    </div>
  );
};

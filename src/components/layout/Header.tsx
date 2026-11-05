/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { FileArchive, Plus, Download } from 'lucide-react';

export type ActiveTab = 'dashboard' | 'new-job' | 'results' | 'profiles' | 'history';

interface HeaderProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  hasActiveJob: boolean;
  onOpenExport: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onTabChange,
  hasActiveJob,
  onOpenExport,
}) => {
  return (
    <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-neutral-200 bg-white sticky top-0 z-30">
      {/* Zone 1: Single text element wordmark */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 rounded-lg bg-neutral-900 text-white flex items-center justify-center font-bold text-sm">
          <FileArchive className="w-4 h-4" />
        </div>
        <button
          onClick={() => onTabChange('dashboard')}
          className="text-lg font-bold tracking-tight text-neutral-900 whitespace-nowrap shrink-0 hover:opacity-85 text-left"
        >
          DocuExtract
        </button>
      </div>

      {/* Zone 2: 4–5 clean single-line text navigation links */}
      <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-neutral-600">
        <button
          onClick={() => onTabChange('dashboard')}
          className={`hover:text-neutral-900 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'dashboard' ? 'text-neutral-900 font-semibold' : ''
          }`}
        >
          Dashboard
        </button>
        <button
          onClick={() => onTabChange('new-job')}
          className={`hover:text-neutral-900 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'new-job' ? 'text-neutral-900 font-semibold' : ''
          }`}
        >
          New Processing Job
        </button>
        <button
          onClick={() => onTabChange('results')}
          className={`hover:text-neutral-900 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'results' ? 'text-neutral-900 font-semibold' : ''
          }`}
        >
          Results &amp; Diagnostics
        </button>
        <button
          onClick={() => onTabChange('profiles')}
          className={`hover:text-neutral-900 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'profiles' ? 'text-neutral-900 font-semibold' : ''
          }`}
        >
          Extraction Profiles
        </button>
        <button
          onClick={() => onTabChange('history')}
          className={`hover:text-neutral-900 transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'history' ? 'text-neutral-900 font-semibold' : ''
          }`}
        >
          Processing History
        </button>
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="flex items-center gap-2.5 shrink-0">
        {hasActiveJob && (
          <button
            onClick={onOpenExport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-700 bg-neutral-100 hover:bg-neutral-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            title="Export CSV Reports"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export CSV</span>
          </button>
        )}
        <button
          onClick={() => onTabChange('new-job')}
          className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Upload Archive</span>
        </button>
      </div>
    </header>
  );
};

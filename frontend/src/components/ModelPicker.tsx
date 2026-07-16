import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelOption, ModelVersion } from '../api/client';
import { modelOptionKey } from '../utils/modelPreference';

interface ModelPickerProps {
  versions: ModelVersion[];
  options: ModelOption[];
  selectedKey: string;
  disabled?: boolean;
  onChange: (key: string) => void;
}

const effortSuffix = /\s+(极速|轻度|中|高|极高|最高|超高|标准|深度|深入|Pro)$/;

function inferredModelLabel(option: ModelOption): string {
  return option.model_label || option.label.replace(effortSuffix, '') || option.model;
}

export function deriveModelVersions(options: ModelOption[]): ModelVersion[] {
  const groups = new Map<string, ModelOption[]>();
  for (const option of options) {
    groups.set(option.model, [...(groups.get(option.model) || []), option]);
  }
  return Array.from(groups, ([model, modelOptions]) => ({
    id: model,
    label: inferredModelLabel(modelOptions[0]),
    short_label: inferredModelLabel(modelOptions[0]),
    model,
    default_thinking_effort: modelOptions.find((option) => option.thinking_effort === 'standard')?.thinking_effort
      || modelOptions[0]?.thinking_effort,
    options: modelOptions,
  }));
}

function preferredVersionOption(version: ModelVersion, current?: ModelOption): ModelOption | undefined {
  return version.options.find((option) => option.thinking_effort === current?.thinking_effort)
    || version.options.find((option) => option.thinking_effort === version.default_thinking_effort)
    || version.options.find((option) => option.thinking_effort === 'standard')
    || version.options[0];
}

export default function ModelPicker({ versions, options, selectedKey, disabled, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const availableVersions = useMemo(
    () => versions.length ? versions : deriveModelVersions(options),
    [options, versions],
  );
  const selectedOption = useMemo(
    () => options.find((option) => modelOptionKey(option) === selectedKey) || options[0],
    [options, selectedKey],
  );
  const selectedVersion = useMemo(
    () => availableVersions.find((version) => version.options.some((option) => modelOptionKey(option) === selectedKey))
      || availableVersions.find((version) => version.model === selectedOption?.model)
      || availableVersions[0],
    [availableVersions, selectedKey, selectedOption?.model],
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setVersionsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setVersionsOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const chooseOption = (option: ModelOption) => {
    onChange(modelOptionKey(option));
    setOpen(false);
    setVersionsOpen(false);
  };

  const chooseVersion = (version: ModelVersion) => {
    const option = preferredVersionOption(version, selectedOption);
    if (option) chooseOption(option);
  };

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker-trigger"
        role="combobox"
        aria-label="选择模型"
        aria-expanded={open}
        aria-controls="model-intelligence-menu"
        disabled={disabled || !selectedOption}
        onClick={() => { setOpen((value) => !value); setVersionsOpen(false); }}
      >
        <span>{selectedOption?.label || '模型加载中'}</span>
        <svg
          className="model-picker-trigger-chevron"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="m3.5 5.75 4.5 4.5 4.5-4.5" />
        </svg>
      </button>

      {open && selectedVersion && (
        <div className="model-picker-popover" id="model-intelligence-menu" role="listbox" aria-label="智能档位">
          <div className="model-picker-heading">智能</div>
          <div className="model-picker-options">
            {selectedVersion.options.map((option) => {
              const key = modelOptionKey(option);
              const selected = key === selectedKey;
              return (
                <button
                  type="button"
                  className="model-picker-option"
                  role="option"
                  aria-selected={selected}
                  key={key}
                  title={option.description}
                  onClick={() => chooseOption(option)}
                >
                  <span>{option.title || option.label}</span>
                  {selected && <span className="model-picker-check" aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
          <div className="model-picker-divider" />
          <button
            type="button"
            className={`model-picker-version-trigger ${versionsOpen ? 'active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={versionsOpen}
            onMouseEnter={() => setVersionsOpen(true)}
            onClick={() => setVersionsOpen(true)}
          >
            <span>{selectedVersion.label}</span>
            <span aria-hidden="true">›</span>
          </button>

          {versionsOpen && (
            <div className="model-version-popover" role="menu" aria-label="模型版本">
              {availableVersions.map((version) => {
                const selected = version.id === selectedVersion.id;
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="model-version-option"
                    key={version.id}
                    title={version.tooltip}
                    onClick={() => chooseVersion(version)}
                  >
                    <span>{version.label}</span>
                    {selected && <span className="model-picker-check" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

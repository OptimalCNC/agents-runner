import { useRef, useEffect } from "react";
import { useAppStore } from "../state/store.js";
import { ensureModelCatalogLoaded, hasCodexModelAccess } from "../state/modelCatalog.js";
import { RefreshIcon, ChevronDownIcon } from "../icons.js";
import { formatRelative, formatDate, formatReasoningEffortLabel } from "../utils/format.js";
import type { CodexModel } from "../types.js";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onReasoningEffortChange?: (model: string | null) => void;
}

function getDefaultCatalogModel(models: CodexModel[]) {
  return models.find((m) => m.isDefault) ?? null;
}

function findCatalogModelByValue(value: string, models: CodexModel[]) {
  const target = String(value ?? "").trim();
  if (!target) return null;
  return models.find((m) => m.model === target) ?? null;
}

export function ModelPicker({ value, onChange, onReasoningEffortChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);

  const catalog = useAppStore((s) => s.modelCatalog);
  const isOpen = useAppStore((s) => s.modelMenuOpen);
  const hasAccess = hasCodexModelAccess();
  const defaultModel = getDefaultCatalogModel(catalog.models);

  // Get visible models for the menu
  const query = (() => {
    const v = value.trim();
    if (!v || findCatalogModelByValue(v, catalog.models)) return "";
    return v.toLowerCase();
  })();

  const visibleModels = catalog.models.filter((m) => {
    if (!query) return true;
    const haystack = [m.displayName, m.model, m.description].filter(Boolean).join("\n").toLowerCase();
    return haystack.includes(query);
  });

  // Notify parent of model change for reasoning effort sync
  useEffect(() => {
    if (onReasoningEffortChange) {
      const selected = findCatalogModelByValue(value, catalog.models);
      onReasoningEffortChange(selected?.model ?? null);
    }
  }, [value, catalog.models.length]);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!isOpen) return;
      if (comboboxRef.current?.contains(e.target as Node)) return;
      useAppStore.setState({ modelMenuOpen: false });
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [isOpen]);

  // Status text
  const modelCount = catalog.models.length;
  let statusTone = "";
  let statusText = "Type a model id manually or open the picker to load the Codex model list.";

  if (catalog.loading) {
    statusTone = "is-loading";
    statusText = "Loading models from Codex\u2026";
  } else if (!hasAccess) {
    statusText = "No Codex auth detected. You can still type a model id manually.";
  } else if (catalog.error && modelCount === 0) {
    statusTone = "is-error";
    statusText = `${catalog.error} Type a model id manually instead.`;
  } else if (catalog.stale && modelCount > 0) {
    const staleAge = catalog.fetchedAt ? formatRelative(catalog.fetchedAt) : "earlier";
    statusTone = "is-warning";
    statusText = `Showing ${modelCount} cached model${modelCount === 1 ? "" : "s"} from ${staleAge}.`;
  } else if (catalog.loaded) {
    if (modelCount === 0) {
      statusTone = "is-warning";
      statusText = "Codex returned no visible models. You can still type a model id manually.";
    } else {
      statusTone = "is-success";
      statusText = defaultModel
        ? `Loaded ${modelCount} model${modelCount === 1 ? "" : "s"} from Codex. Default is ${defaultModel.model}.`
        : `Loaded ${modelCount} model${modelCount === 1 ? "" : "s"} from Codex.`;
    }
  }

  const placeholder = defaultModel ? `Codex default (${defaultModel.model})` : "Codex default";

  function handleMenuSelect(modelValue: string) {
    onChange(modelValue);
    useAppStore.setState({ modelMenuOpen: false });
    inputRef.current?.focus();
  }

  function handleToggle() {
    const next = !isOpen;
    useAppStore.setState({ modelMenuOpen: next });
    if (next && hasAccess && !catalog.loaded && !catalog.loading) {
      void ensureModelCatalogLoaded();
    }
  }

  function handleInputFocus() {
    if (!catalog.loaded && !catalog.loading) return;
    useAppStore.setState({ modelMenuOpen: true });
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    onChange(v);
    if (hasAccess || catalog.loaded || catalog.loading) {
      useAppStore.setState({ modelMenuOpen: true });
    }
  }

  return (
    <div className="model-combobox" ref={comboboxRef}>
      <div className="model-combobox-row">
        <input
          ref={inputRef}
          id="model"
          name="model"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onFocus={handleInputFocus}
          onChange={handleInputChange}
        />
        <button
          className="btn-icon model-combobox-action"
          type="button"
          aria-label="Refresh models"
          title={!hasAccess ? "Live model discovery needs Codex auth" : catalog.loading ? "Loading models from Codex" : "Refresh models"}
          disabled={!hasAccess || catalog.loading}
          onClick={async () => {
            useAppStore.setState({ modelMenuOpen: true });
            try { await ensureModelCatalogLoaded(true); } catch {}
          }}
        >
          <RefreshIcon />
        </button>
        <button
          className={`btn-icon model-combobox-action model-combobox-toggle${isOpen ? " is-open" : ""}`}
          type="button"
          aria-label="Show models"
          aria-expanded={isOpen ? "true" : "false"}
          title="Show models"
          onClick={handleToggle}
        >
          <ChevronDownIcon />
        </button>
      </div>
      <div
        className={`form-hint model-combobox-status${statusTone ? ` ${statusTone}` : ""}`}
        title={catalog.fetchedAt ? formatDate(catalog.fetchedAt) : ""}
      >
        {statusText}
      </div>
      {isOpen && (
        <div className="model-combobox-menu">
          {catalog.loading && catalog.models.length === 0 ? (
            <div className="model-combobox-empty">Loading models from Codex\u2026</div>
          ) : !hasAccess && catalog.models.length === 0 ? (
            <div className="model-combobox-empty">
              No Codex credentials detected for live model discovery. You can still type any model id manually.
            </div>
          ) : catalog.error && catalog.models.length === 0 ? (
            <div className="model-combobox-empty">{catalog.error}</div>
          ) : (
            <>
              <button
                className={`model-option${value ? "" : " is-selected"}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleMenuSelect("")}
              >
                <span className="model-option-title-row">
                  <span className="model-option-title">
                    {defaultModel ? `Codex default (${defaultModel.model})` : "Codex default"}
                  </span>
                  <span className="model-option-badge">Auto</span>
                </span>
                <span className="model-option-desc">
                  {defaultModel
                    ? defaultModel.defaultReasoningEffort && defaultModel.defaultReasoningEffort !== "none"
                      ? `Use Codex's current default model. Default reasoning is ${formatReasoningEffortLabel(defaultModel.defaultReasoningEffort)}.`
                      : "Use Codex's current default model."
                    : "Use Codex's current default model."}
                </span>
              </button>
              {visibleModels.length === 0 ? (
                <div className="model-combobox-empty">
                  No matching live models. You can still type any model id manually.
                </div>
              ) : (
                visibleModels.map((m) => (
                  <button
                    key={m.model}
                    className={`model-option${m.model === value ? " is-selected" : ""}`}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleMenuSelect(m.model)}
                  >
                    <span className="model-option-title-row">
                      <span className="model-option-title">{m.displayName || m.model}</span>
                      {m.isDefault && <span className="model-option-badge">Default</span>}
                    </span>
                    <span className="model-option-model">{m.model}</span>
                    {m.description && (
                      <span className="model-option-desc">{m.description}</span>
                    )}
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

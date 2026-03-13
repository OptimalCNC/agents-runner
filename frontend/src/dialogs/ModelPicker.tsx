import { useRef, useEffect } from "preact/hooks";
import { modelCatalog, modelMenuOpen, config } from "../state/store.js";
import { apiLoadModels } from "../state/api.js";
import { RefreshIcon, ChevronDownIcon } from "../icons.js";
import { formatRelative, formatDate, formatReasoningEffortLabel } from "../utils/format.js";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onReasoningEffortChange?: (model: string | null) => void;
}

function hasCodexModelAccess() {
  const env = config.value?.codexEnvironment;
  return Boolean(env?.hasOpenAIApiKey || env?.hasCodexProfile);
}

function getDefaultCatalogModel() {
  return modelCatalog.value.models.find((m) => m.isDefault) ?? null;
}

function findCatalogModelByValue(value: string) {
  const target = String(value ?? "").trim();
  if (!target) return null;
  return modelCatalog.value.models.find((m) => m.model === target) ?? null;
}

async function ensureModelCatalogLoaded(refresh = false) {
  if (!hasCodexModelAccess()) return;
  if (!refresh && modelCatalog.value.loaded) return;
  if (modelCatalog.value.loading) return;

  modelCatalog.value = { ...modelCatalog.value, loading: true, error: "" };
  try {
    const payload = await apiLoadModels(refresh);
    modelCatalog.value = {
      loading: false,
      loaded: true,
      stale: Boolean(payload.stale),
      fetchedAt: payload.fetchedAt || null,
      models: Array.isArray(payload.models) ? payload.models.filter((m) => !m.hidden) : [],
      error: "",
    };
  } catch (err) {
    modelCatalog.value = {
      ...modelCatalog.value,
      loading: false,
      error: (err as Error).message,
    };
  }
}

export function ModelPicker({ value, onChange, onReasoningEffortChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);

  const catalog = modelCatalog.value;
  const isOpen = modelMenuOpen.value;
  const hasAccess = hasCodexModelAccess();
  const defaultModel = getDefaultCatalogModel();

  // Get visible models for the menu
  const query = (() => {
    const v = value.trim();
    if (!v || findCatalogModelByValue(v)) return "";
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
      const selected = findCatalogModelByValue(value);
      onReasoningEffortChange(selected?.model ?? null);
    }
  }, [value, catalog.models.length]);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!isOpen) return;
      if (comboboxRef.current?.contains(e.target as Node)) return;
      modelMenuOpen.value = false;
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
    modelMenuOpen.value = false;
    inputRef.current?.focus();
  }

  function handleToggle() {
    modelMenuOpen.value = !modelMenuOpen.value;
    if (modelMenuOpen.value && hasAccess && !catalog.loaded && !catalog.loading) {
      void ensureModelCatalogLoaded();
    }
  }

  function handleInputFocus() {
    if (!catalog.loaded && !catalog.loading) return;
    modelMenuOpen.value = true;
  }

  function handleInputChange(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    onChange(v);
    if (hasAccess || catalog.loaded || catalog.loading) {
      modelMenuOpen.value = true;
    }
  }

  return (
    <div class="model-combobox" ref={comboboxRef}>
      <div class="model-combobox-row">
        <input
          ref={inputRef}
          id="model"
          name="model"
          value={value}
          placeholder={placeholder}
          autocomplete="off"
          spellcheck={false}
          onFocus={handleInputFocus}
          onInput={handleInputChange}
        />
        <button
          class="btn-icon model-combobox-action"
          type="button"
          aria-label="Refresh models"
          title={!hasAccess ? "Live model discovery needs Codex auth" : catalog.loading ? "Loading models from Codex" : "Refresh models"}
          disabled={!hasAccess || catalog.loading}
          onClick={async () => {
            modelMenuOpen.value = true;
            try { await ensureModelCatalogLoaded(true); } catch {}
          }}
        >
          <RefreshIcon />
        </button>
        <button
          class={`btn-icon model-combobox-action model-combobox-toggle${isOpen ? " is-open" : ""}`}
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
        class={`form-hint model-combobox-status${statusTone ? ` ${statusTone}` : ""}`}
        title={catalog.fetchedAt ? formatDate(catalog.fetchedAt) : ""}
      >
        {statusText}
      </div>
      {isOpen && (
        <div class="model-combobox-menu">
          {catalog.loading && catalog.models.length === 0 ? (
            <div class="model-combobox-empty">Loading models from Codex\u2026</div>
          ) : !hasAccess && catalog.models.length === 0 ? (
            <div class="model-combobox-empty">
              No Codex credentials detected for live model discovery. You can still type any model id manually.
            </div>
          ) : catalog.error && catalog.models.length === 0 ? (
            <div class="model-combobox-empty">{catalog.error}</div>
          ) : (
            <>
              <button
                class={`model-option${value ? "" : " is-selected"}`}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleMenuSelect("")}
              >
                <span class="model-option-title-row">
                  <span class="model-option-title">
                    {defaultModel ? `Codex default (${defaultModel.model})` : "Codex default"}
                  </span>
                  <span class="model-option-badge">Auto</span>
                </span>
                <span class="model-option-desc">
                  {defaultModel
                    ? defaultModel.defaultReasoningEffort && defaultModel.defaultReasoningEffort !== "none"
                      ? `Use Codex's current default model. Default reasoning is ${formatReasoningEffortLabel(defaultModel.defaultReasoningEffort)}.`
                      : "Use Codex's current default model."
                    : "Use Codex's current default model."}
                </span>
              </button>
              {visibleModels.length === 0 ? (
                <div class="model-combobox-empty">
                  No matching live models. You can still type any model id manually.
                </div>
              ) : (
                visibleModels.map((model) => (
                  <button
                    key={model.model}
                    class={`model-option${model.model === value ? " is-selected" : ""}`}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleMenuSelect(model.model)}
                  >
                    <span class="model-option-title-row">
                      <span class="model-option-title">{model.displayName || model.model}</span>
                      {model.isDefault && <span class="model-option-badge">Default</span>}
                    </span>
                    <span class="model-option-model">{model.model}</span>
                    {model.description && (
                      <span class="model-option-desc">{model.description}</span>
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

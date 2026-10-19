import { useEffect, useMemo, useRef, useState } from 'react';
import { isModelTag } from '../../electron/shared';
import { MODEL_CATALOG, findCatalogModel, normalizeTag, parseParamsB, type CatalogModel } from '../data/modelCatalog';
import { useT, type StringKey } from '../i18n';
import { useModelStore, type DownloadState } from '../store/useModelStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type { InstalledModel, ModelOpError } from '../types/bridge';
import { estimateFit, type Hardware, type ModelSize } from '../utils/modelFit';
import { useScrollFade } from '../utils/useScrollFade';

type Tab = 'installed' | 'catalog';
type T = ReturnType<typeof useT>;

const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
const mb = (bytes: number) => Math.round(bytes / 1e6);

/** catalog numbers, or for an installed model its real size and (if known) parameter count */
function sizeOf(model: CatalogModel | InstalledModel): ModelSize | null {
  if ('tag' in model) {
    return {
      diskGB: model.diskGB,
      paramsB: parseParamsB(model.params),
      activeParamsB: model.activeParams ? parseParamsB(model.activeParams) : undefined
    };
  }
  if (model.sizeBytes <= 0) return null;
  const active = findCatalogModel(model.name)?.activeParams;
  return {
    diskGB: model.sizeBytes / 1e9,
    paramsB: model.parameterSize ? parseParamsB(model.parameterSize) : undefined,
    activeParamsB: active ? parseParamsB(active) : undefined
  };
}

const errorText = (t: T, error: ModelOpError | undefined, detail?: string) =>
  t(`models.error.${error ?? 'failed'}` as StringKey) + (detail && error === 'failed' ? ` (${detail})` : '');

/**
 * The model browser: installed models (use / delete) and a curated catalog
 * with a "will it run?" badge and downloads. Fixed header, scrolling body;
 * Esc and a click outside close it (Esc closes the delete confirm first).
 */
export default function ModelsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { installed, loading, listError, download, refresh, remove, startDownload, cancelDownload, dismissDownload } =
    useModelStore();

  const [tab, setTab] = useState<Tab>('installed');
  const [hardware, setHardware] = useState<Hardware | null>(null);
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [customTag, setCustomTag] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useScrollFade(bodyRef);

  useEffect(() => {
    void refresh();
    const bridge = window.companion;
    if (!bridge) return;
    void Promise.all([bridge.queryGpu().catch(() => null), bridge.queryRam().catch(() => null)]).then(([gpu, ram]) => {
      if (ram) setHardware({ vramGB: gpu ? gpu.memoryTotalMb / 1024 : 0, ramGB: ram.totalMb / 1024 });
    });
  }, [refresh]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmName) setConfirmName(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmName, onClose]);

  const installedNames = useMemo(() => new Set(installed.map((m) => normalizeTag(m.name))), [installed]);
  const current = normalizeTag(settings.ollamaModel);
  const downloading = download?.phase === 'running';
  const isEmbedding = (tag: string) =>
    findCatalogModel(tag)?.kind === 'embedding' ||
    installed.some((m) => m.embedding && normalizeTag(m.name) === normalizeTag(tag));

  const use = (name: string) => void updateSettings({ ollamaModel: name });

  const confirmDelete = async () => {
    const name = confirmName;
    setConfirmName(null);
    if (!name) return;
    const result = await remove(name);
    setDeleteError(result.ok ? null : t('models.deleteFailed', { reason: errorText(t, result.error, result.detail) }));
  };

  const customValid = isModelTag(customTag.trim());
  const customMatch = customValid ? findCatalogModel(customTag) : undefined;
  const downloadCustom = () => {
    if (customValid && !downloading) void startDownload(customTag.trim());
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'installed', label: t('models.tabInstalled') },
    { id: 'catalog', label: t('models.tabCatalog') }
  ];

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center rounded-3xl bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="models-title"
        tabIndex={-1}
        className="glass-panel panel-opaque mx-4 flex h-[90%] w-full max-w-[640px] flex-col overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* fixed part: title, close, tabs, download progress */}
        <div className="shrink-0 px-5 pt-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id="models-title" className="font-display text-[16px] font-semibold text-text-primary">
              {t('models.title')}
            </h2>
            <button
              onClick={onClose}
              title={t('models.close')}
              aria-label={t('models.close')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div role="tablist" className="mb-3 flex gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
            {tabs.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`flex-1 whitespace-nowrap rounded-md px-1 py-1.5 text-[11.5px] font-medium transition-colors ${
                  tab === item.id
                    ? 'bg-vellum-bronze-light/25 text-vellum-bronze-light'
                    : 'text-text-secondary hover:bg-white/10 hover:text-text-primary'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {download && (
            <DownloadBar
              download={download}
              canUse={!isEmbedding(download.tag)}
              onCancel={cancelDownload}
              onDismiss={dismissDownload}
              onUse={() => {
                use(download.tag);
                dismissDownload();
              }}
            />
          )}
        </div>

        {/* scrolling body */}
        <div
          ref={bodyRef}
          role="tabpanel"
          className="scroll-fade chat-scroll mb-3 mr-1.5 min-h-0 flex-1 overflow-y-auto pb-4 pl-5 pr-3.5"
        >
          {tab === 'installed' ? (
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[11px] text-text-secondary">
                  {loading ? t('models.loading') : t('models.count', { n: installed.length })}
                </p>
                <SmallButton onClick={() => void refresh()} disabled={loading}>
                  {t('models.refresh')}
                </SmallButton>
              </div>
              {listError && <p className="mb-2 text-[11.5px] text-danger">{errorText(t, listError)}</p>}
              {deleteError && <p className="mb-2 text-[11.5px] text-danger">{deleteError}</p>}
              {!loading && !listError && installed.length === 0 && (
                <p className="text-[11.5px] text-text-secondary">{t('models.empty')}</p>
              )}
              <ul className="space-y-2">
                {installed.map((model) => (
                  <InstalledRow
                    key={model.name}
                    model={model}
                    hardware={hardware}
                    contextTokens={settings.ollamaContextSize}
                    inUse={normalizeTag(model.name) === current}
                    onUse={() => use(model.name)}
                    onDelete={() => setConfirmName(model.name)}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <div>
              <div className="flex gap-2">
                <input
                  value={customTag}
                  onChange={(e) => setCustomTag(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && downloadCustom()}
                  placeholder={t('models.tagPlaceholder')}
                  aria-label={t('models.tagPlaceholder')}
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[var(--vellum-input-bg)] px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-secondary/40 focus:border-vellum-bronze-light/60 focus:outline-none"
                />
                <SmallButton primary onClick={downloadCustom} disabled={!customValid || downloading}>
                  {t('models.download')}
                </SmallButton>
              </div>
              {customTag.trim() !== '' && !customValid && (
                <p className="mt-1 text-[11px] text-danger">{t('models.tagInvalid')}</p>
              )}
              {customMatch && hardware && (
                <div className="mt-1.5">
                  <FitBadge size={sizeOf(customMatch)} contextTokens={settings.ollamaContextSize} hardware={hardware} />
                </div>
              )}
              <p className="mb-2 mt-2 text-[10.5px] text-text-secondary/70">{t('models.approx')}</p>
              <ul className="space-y-2">
                {MODEL_CATALOG.map((model) => (
                  <CatalogRow
                    key={model.tag}
                    model={model}
                    hardware={hardware}
                    contextTokens={settings.ollamaContextSize}
                    installed={installedNames.has(normalizeTag(model.tag))}
                    inUse={normalizeTag(model.tag) === current}
                    downloadDisabled={downloading}
                    onDownload={() => void startDownload(model.tag)}
                    onUse={() => use(model.tag)}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        {confirmName && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center rounded-[22px] bg-black/50"
            onClick={() => setConfirmName(null)}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="models-confirm-title"
              className="glass-panel panel-opaque mx-4 w-full max-w-[320px] p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="models-confirm-title" className="break-all text-[13px] font-semibold text-text-primary">
                {t('models.confirmTitle', { name: confirmName })}
              </h3>
              <p className="mt-1.5 text-[11.5px] leading-snug text-text-secondary">{t('models.confirmBody')}</p>
              <div className="mt-3 flex justify-end gap-2">
                <SmallButton autoFocus onClick={() => setConfirmName(null)}>
                  {t('models.cancel')}
                </SmallButton>
                <SmallButton danger onClick={() => void confirmDelete()}>
                  {t('models.delete')}
                </SmallButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DownloadBar({
  download,
  canUse,
  onCancel,
  onDismiss,
  onUse
}: {
  download: DownloadState;
  canUse: boolean;
  onCancel: () => void;
  onDismiss: () => void;
  onUse: () => void;
}) {
  const t = useT();
  const percent = download.totalBytes > 0 ? Math.floor((download.completedBytes / download.totalBytes) * 100) : 0;

  return (
    <div role="status" data-download={download.phase} className="mb-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      {download.phase === 'running' && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[11.5px] text-text-primary">{t('models.downloading', { tag: download.tag })}</p>
            <SmallButton onClick={onCancel}>{t('models.cancel')}</SmallButton>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-vellum-bronze-light transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-[10.5px] text-text-secondary">
            {download.totalBytes > 0
              ? `${percent}% · ${mb(download.completedBytes)} / ${mb(download.totalBytes)} MB`
              : t('models.starting')}
          </p>
        </>
      )}
      {download.phase === 'done' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 break-all text-[11.5px] text-success">{t('models.downloadDone', { tag: download.tag })}</p>
          <div className="flex shrink-0 gap-1.5">
            {canUse && (
              <SmallButton primary onClick={onUse}>
                {t('models.useNow')}
              </SmallButton>
            )}
            <SmallButton onClick={onDismiss}>{t('models.dismiss')}</SmallButton>
          </div>
        </div>
      )}
      {download.phase === 'error' && (
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 break-words text-[11.5px] text-danger">
            {t('models.downloadFailed', { tag: download.tag, reason: errorText(t, download.error, download.detail) })}
          </p>
          <SmallButton onClick={onDismiss}>{t('models.dismiss')}</SmallButton>
        </div>
      )}
    </div>
  );
}

function InstalledRow({
  model,
  hardware,
  contextTokens,
  inUse,
  onUse,
  onDelete
}: {
  model: InstalledModel;
  hardware: Hardware | null;
  contextTokens: number;
  inUse: boolean;
  onUse: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const meta = [`${gb(model.sizeBytes)} GB`, model.family, model.parameterSize, model.quantization].filter(Boolean).join(' · ');
  return (
    <li data-installed={model.name} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] font-medium text-text-primary">
            <span className="break-all">{model.name}</span>
            {inUse && <Chip className="border-success/40 bg-success/10 text-success">{t('models.inUse')}</Chip>}
            {hardware && <FitBadge size={sizeOf(model)} contextTokens={contextTokens} hardware={hardware} />}
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">{meta}</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {!model.embedding && (
            <SmallButton onClick={onUse} disabled={inUse}>
              {t('models.use')}
            </SmallButton>
          )}
          <SmallButton danger onClick={onDelete}>
            {t('models.delete')}
          </SmallButton>
        </div>
      </div>
    </li>
  );
}

function CatalogRow({
  model,
  hardware,
  contextTokens,
  installed,
  inUse,
  downloadDisabled,
  onDownload,
  onUse
}: {
  model: CatalogModel;
  hardware: Hardware | null;
  contextTokens: number;
  installed: boolean;
  inUse: boolean;
  downloadDisabled: boolean;
  onDownload: () => void;
  onUse: () => void;
}) {
  const t = useT();
  const params = model.activeParams ? `${model.params} (${t('models.active', { n: model.activeParams })})` : model.params;
  const meta = [params, `${model.diskGB} GB`, t('models.context', { n: model.contextK }), model.license].join(' · ');
  const embedding = model.kind === 'embedding';

  return (
    <li data-catalog={model.tag} className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-all text-[12.5px] font-medium text-text-primary">{model.tag}</span>
          <Chip className="border-white/15 bg-white/5 text-text-secondary">{t(`models.kind.${model.kind}` as StringKey)}</Chip>
          {hardware && <FitBadge size={sizeOf(model)} contextTokens={contextTokens} hardware={hardware} />}
        </div>
        <div className="flex shrink-0 gap-1.5">
          {installed ? (
            !embedding && (
              <SmallButton onClick={onUse} disabled={inUse}>
                {inUse ? t('models.inUse') : t('models.use')}
              </SmallButton>
            )
          ) : (
            <SmallButton primary onClick={onDownload} disabled={downloadDisabled}>
              {t('models.download')}
            </SmallButton>
          )}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-text-secondary">
        {meta}
        {installed && <span className="text-success"> · {t('models.installed')}</span>}
      </p>
      <p className="mt-0.5 text-[11.5px] leading-snug text-text-secondary">
        {model.strengths}
        {model.languagesNote && <span className="text-text-secondary/70"> {model.languagesNote}</span>}
      </p>
    </li>
  );
}

function FitBadge({ size, contextTokens, hardware }: { size: ModelSize | null; contextTokens: number; hardware: Hardware }) {
  const t = useT();
  if (!size) return null;
  const result = estimateFit(size, contextTokens, hardware);
  const label =
    result.fit === 'gpu'
      ? t('models.fit.gpu')
      : result.fit === 'no'
        ? t('models.fit.no')
        : result.reason === 'ramOnly'
          ? t('models.fit.ramOnly')
          : t('models.fit.gpuRam');
  const color =
    result.fit === 'gpu'
      ? 'border-success/40 bg-success/10 text-success'
      : result.fit === 'no'
        ? 'border-danger/40 bg-danger/10 text-danger'
        : 'border-warning/40 bg-warning/10 text-warning';
  const tooltip = [
    t('models.fit.tooltip', {
      need: result.estimatedGB,
      kv: result.kvCacheGB,
      ctx: contextTokens,
      vram: result.usableVramGB,
      ram: result.usableRamGB
    }),
    hardware.vramGB === 0 ? t('models.fit.noGpu') : '',
    result.moe ? t('models.moe') : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <Chip className={color} title={tooltip} data-fit={result.fit}>
        {label}
      </Chip>
      {result.moe && <span className="text-[10.5px] text-vellum-teal">{t('models.moe')}</span>}
    </>
  );
}

function Chip({
  className,
  children,
  ...rest
}: { className: string; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement> & { 'data-fit'?: string }) {
  return (
    <span
      {...rest}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-medium leading-tight ${className}`}
    >
      {children}
    </span>
  );
}

function SmallButton({
  primary,
  danger,
  disabled,
  autoFocus,
  onClick,
  children
}: {
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const tone = danger
    ? 'border-danger/40 bg-danger/10 text-danger hover:bg-danger/20'
    : primary
      ? 'border-vellum-bronze-light/40 bg-vellum-bronze-light/10 text-vellum-bronze-light hover:bg-vellum-bronze-light/20'
      : 'border-white/10 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text-primary';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      className={`shrink-0 whitespace-nowrap rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {children}
    </button>
  );
}

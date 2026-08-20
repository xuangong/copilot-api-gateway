/**
 * 代理节点的结构化编辑表单。
 *
 * URL 输入框和结构化字段双向同步：改字段会把 `draft.url` 置回 `null`
 * （表示"以字段为准"，URL 框转为显示推导结果）；改 URL 框会存下原文，
 * 能解析就顺带覆盖字段。校验规则全部来自 proxy-form-config.ts。
 */
import { useT } from '../../state/i18n'
import type { ProxyConfig, Ss2022Method, SsMethod } from '@vibe-core/proxy/proxy-config'
import {
  DEFAULT_PORTS,
  FORM_KINDS,
  type FormKind,
  type ProxyDraft,
  defaultsFor,
  draftIssues,
  draftUrl,
  formKindOf,
  parseProxyUriSafe,
} from './proxy-form-config'

const INPUT_CLS =
  'w-full bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs font-mono'

/** select 的取值必须落回联合类型，所以枚举在这里各留一份运行时数组。 */
const SS_METHODS: readonly SsMethod[] = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']
const SS2022_METHODS: readonly Ss2022Method[] = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
]

/** 可选字段清空时要写回 `undefined`，写 `''` 会让 URL 里多出空参数。 */
const orUndefined = (v: string): string | undefined => (v === '' ? undefined : v)

function Field(props: {
  label: string
  value: string
  error?: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const t = useT()
  return (
    <label className="block">
      <span className="block text-[11px] text-themed-dim mb-0.5">{props.label}</span>
      <input
        className={INPUT_CLS}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.error ? (
        <span className="block text-[11px] text-accent-red mt-0.5">{t(props.error)}</span>
      ) : null}
    </label>
  )
}

export function ProxyForm(props: {
  draft: ProxyDraft
  onChange: (next: ProxyDraft) => void
}) {
  const t = useT()
  const { draft, onChange } = props
  const issues = draftIssues(draft)
  const kind = formKindOf(draft.config)

  /** 规则 1：改结构化字段 → 回到"以字段为准"。 */
  const setConfig = (next: ProxyConfig) => {
    onChange({ ...draft, config: next, url: null })
  }

  /** 规则 2：改 URL 框 → 存原文，能解析就同步字段。 */
  const setUrl = (raw: string) => {
    const trimmed = raw.trim()
    const parsed = trimmed ? parseProxyUriSafe(trimmed) : null
    onChange(parsed ? { ...draft, url: raw, config: parsed } : { ...draft, url: raw })
  }

  /** 规则 3：切协议 → 保留 host/name；端口没被手动改过就换成新协议的默认值。 */
  const setKind = (next: FormKind) => {
    const port = draft.config.port === DEFAULT_PORTS[kind] ? DEFAULT_PORTS[next] : draft.config.port
    setConfig(defaultsFor(next, { host: draft.config.host, port, name: draft.config.name }))
  }

  const setPort = (raw: string) => {
    const n = raw.trim() === '' ? 0 : Number(raw)
    setConfig({ ...draft.config, port: Number.isFinite(n) ? n : 0 })
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyNameLabel')}
          value={draft.name}
          error={issues.name}
          onChange={(v) => onChange({ ...draft, name: v, url: null })}
        />
        <label className="block">
          <span className="block text-[11px] text-themed-dim mb-0.5">
            {t('dash.proxyKindLabel')}
          </span>
          <select
            className={INPUT_CLS}
            value={kind}
            onChange={(e) => {
              // find() 把 string 收窄回 FormKind；理论上 select 不会给出别的值，
              // 但守卫比断言便宜，也顺带保住了 FORM_KINDS 改动时的类型检查。
              const k = FORM_KINDS.find((x) => x === e.target.value)
              if (k) setKind(k)
            }}
          >
            {FORM_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyHostLabel')}
          value={draft.config.host}
          error={issues.config.host}
          placeholder="node1.example.com"
          onChange={(v) => setConfig({ ...draft.config, host: v })}
        />
        <Field
          label={t('dash.proxyPortLabel')}
          value={draft.config.port ? String(draft.config.port) : ''}
          error={issues.config.port}
          placeholder={String(DEFAULT_PORTS[kind])}
          onChange={setPort}
        />
      </div>

      <KindFields config={draft.config} issues={issues.config} setConfig={setConfig} />

      <Field
        label={t('dash.proxyDialTimeoutLabel')}
        value={draft.dialTimeoutSeconds}
        error={issues.dialTimeout}
        placeholder={t('dash.proxyDialTimeoutDefault')}
        onChange={(v) => onChange({ ...draft, dialTimeoutSeconds: v })}
      />

      <Field
        label={t('dash.proxyUrlLabel')}
        value={draftUrl(draft)}
        error={issues.url}
        placeholder="trojan://password@host:443"
        onChange={setUrl}
      />
      <p className="text-[11px] text-themed-dim">{t('dash.proxyUrlSyncHint')}</p>
    </div>
  )
}

/**
 * 每种协议各自的字段。共有的 host / port 已在上面渲染过。
 *
 * `setConfig` 收的是新值而不是 updater：`switch (config.kind)` 已经把闭包里的
 * `config` 收窄到具体分支，直接 spread 它就能保住判别式，一个断言都不需要。
 */
function KindFields(props: {
  config: ProxyConfig
  issues: Record<string, string | undefined>
  setConfig: (next: ProxyConfig) => void
}) {
  const t = useT()
  const { config, issues, setConfig } = props

  switch (config.kind) {
  case 'http':
  case 'socks5':
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyUsernameLabel')}
          value={config.username ?? ''}
          onChange={(v) => setConfig({ ...config, username: orUndefined(v) })}
        />
        <Field
          label={t('dash.proxyPasswordLabel')}
          value={config.password ?? ''}
          onChange={(v) => setConfig({ ...config, password: orUndefined(v) })}
        />
      </div>
    )
  case 'ss':
    return (
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[11px] text-themed-dim mb-0.5">
            {t('dash.proxyMethodLabel')}
          </span>
          <select
            className={INPUT_CLS}
            value={config.method}
            onChange={(e) => {
              const m = SS_METHODS.find((x) => x === e.target.value)
              if (m) setConfig({ ...config, method: m })
            }}
          >
            {SS_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <Field
          label={t('dash.proxyPasswordLabel')}
          value={config.password}
          error={issues.password}
          onChange={(v) => setConfig({ ...config, password: v })}
        />
      </div>
    )
  case 'ss2022':
    return (
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-[11px] text-themed-dim mb-0.5">
            {t('dash.proxyMethodLabel')}
          </span>
          <select
            className={INPUT_CLS}
            value={config.method}
            onChange={(e) => {
              const m = SS2022_METHODS.find((x) => x === e.target.value)
              if (m) setConfig({ ...config, method: m })
            }}
          >
            {SS2022_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <Field
          label={t('dash.proxyPskLabel')}
          value={config.passwordBase64}
          error={issues.passwordBase64}
          onChange={(v) => setConfig({ ...config, passwordBase64: v })}
        />
      </div>
    )
  case 'trojan':
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyPasswordLabel')}
          value={config.password}
          error={issues.password}
          onChange={(v) => setConfig({ ...config, password: v })}
        />
        <Field
          label={t('dash.proxySniLabel')}
          value={config.sni ?? ''}
          onChange={(v) => setConfig({ ...config, sni: orUndefined(v) })}
        />
      </div>
    )
  case 'vless-tcp':
    return (
      <Field
        label={t('dash.proxyUuidLabel')}
        value={config.uuid}
        error={issues.uuid}
        onChange={(v) => setConfig({ ...config, uuid: v })}
      />
    )
  case 'vless-ws':
    return (
      <div className="grid grid-cols-3 gap-2">
        <Field
          label={t('dash.proxyUuidLabel')}
          value={config.uuid}
          error={issues.uuid}
          onChange={(v) => setConfig({ ...config, uuid: v })}
        />
        <Field
          label={t('dash.proxyWsPathLabel')}
          value={config.path}
          error={issues.path}
          placeholder="/"
          onChange={(v) => setConfig({ ...config, path: v })}
        />
        <Field
          label={t('dash.proxyWsHostLabel')}
          value={config.wsHost ?? ''}
          onChange={(v) => setConfig({ ...config, wsHost: orUndefined(v) })}
        />
      </div>
    )
  case 'reality':
    return (
      <div className="grid grid-cols-2 gap-2">
        <Field
          label={t('dash.proxyUuidLabel')}
          value={config.uuid}
          error={issues.uuid}
          onChange={(v) => setConfig({ ...config, uuid: v })}
        />
        <Field
          label={t('dash.proxyPublicKeyLabel')}
          value={config.publicKey}
          error={issues.publicKey}
          onChange={(v) => setConfig({ ...config, publicKey: v })}
        />
        <Field
          label={t('dash.proxyServerNameLabel')}
          value={config.serverName}
          error={issues.serverName}
          onChange={(v) => setConfig({ ...config, serverName: v })}
        />
        <Field
          label={t('dash.proxyShortIdLabel')}
          value={config.shortId ?? ''}
          onChange={(v) => setConfig({ ...config, shortId: orUndefined(v) })}
        />
      </div>
    )
  }
}

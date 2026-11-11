/**
 * 代理节点的结构化编辑表单。
 *
 * URL 输入框和结构化字段双向同步：改字段会把 `draft.url` 置回 `null`
 * （表示"以字段为准"，URL 框转为显示推导结果）；改 URL 框会存下原文，
 * 能解析就顺带覆盖字段。校验规则全部来自 proxy-form-config.ts。
 */
import type { Ref } from 'react'
import { useT } from '../../state/i18n'
import type { ProxyConfig, Ss2022Method, SsMethod } from '@vibe-core/proxy/proxy-config'
import { Select } from '../../ui/select'
import { Field } from '../upstreams/form/Field'
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

/** select 的取值必须落回联合类型，所以枚举在这里各留一份运行时数组。 */
const SS_METHODS: readonly SsMethod[] = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']
const SS2022_METHODS: readonly Ss2022Method[] = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
]

/**
 * 可选字段清空时写回 `undefined` 而不是 `''`：`formatProxyUri` 只跳过
 * `undefined`，留着空串会格式化出 `?sni=`、`host=` 这类空查询参数。
 */
const orUndefined = (v: string): string | undefined => (v === '' ? undefined : v)

/**
 * 一个带可见标签的文本框。标签用 htmlFor 关联；校验错误（i18n 键）用
 * aria-invalid + aria-describedby 挂到输入框上。全局 input 规则的 font-family
 * 是 inherit，所以等宽字体加在外层 div 上。
 */
function TextField(props: {
  label: string
  value: string
  error?: string
  placeholder?: string
  inputRef?: Ref<HTMLInputElement>
  onChange: (v: string) => void
}) {
  const t = useT()
  return (
    <Field label={props.label} error={props.error ? t(props.error) : undefined}>
      {({ id, describedBy }) => (
        <div className="font-mono">
          <input
            ref={props.inputRef}
            id={id}
            type="text"
            value={props.value}
            placeholder={props.placeholder}
            aria-invalid={props.error ? true : undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => props.onChange(e.target.value)}
          />
        </div>
      )}
    </Field>
  )
}

/** 选项就是取值本身（协议名、加密方法都不翻译）。 */
function ChoiceField<T extends string>(props: {
  label: string
  value: T
  choices: readonly T[]
  onChange: (v: T) => void
}) {
  return (
    <Field label={props.label} labelledBy>
      {({ labelId }) => (
        <Select
          value={props.value}
          labelledBy={labelId}
          options={props.choices.map((c) => ({ value: c, label: c }))}
          onChange={(v) => {
            // find() 把 string 收窄回联合类型；理论上 select 不会给出别的值，
            // 但守卫比断言便宜，也顺带保住了枚举改动时的类型检查。
            const c = props.choices.find((x) => x === v)
            if (c) props.onChange(c)
          }}
        />
      )}
    </Field>
  )
}

export function ProxyForm(props: {
  draft: ProxyDraft
  onChange: (next: ProxyDraft) => void
  /** 名称输入框；面板打开时父组件把焦点移到这里。 */
  nameRef?: Ref<HTMLInputElement>
}) {
  const t = useT()
  const { draft, onChange } = props
  // 红字一开始就显示。设计稿写的是"第一次点保存后才显示"，但保存按钮在草稿
  // 不合法时是禁用的 —— 那条路径永远走不到，只会留下一个点不动、也不说为什么
  // 的按钮。要真按设计稿来，得把保存改成常亮、点击时再决定提交还是亮红字，
  // 那是另一次改动。
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
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('dash.proxyNameLabel')}
          value={draft.name}
          error={issues.name}
          inputRef={props.nameRef}
          onChange={(v) => onChange({ ...draft, name: v, url: null })}
        />
        <ChoiceField label={t('dash.proxyKindLabel')} value={kind} choices={FORM_KINDS} onChange={setKind} />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('dash.proxyHostLabel')}
          value={draft.config.host}
          error={issues.config.host}
          placeholder="node1.example.com"
          onChange={(v) => setConfig({ ...draft.config, host: v })}
        />
        <TextField
          label={t('dash.proxyPortLabel')}
          value={draft.config.port ? String(draft.config.port) : ''}
          error={issues.config.port}
          placeholder={String(DEFAULT_PORTS[kind])}
          onChange={setPort}
        />
      </div>

      <KindFields config={draft.config} issues={issues.config} setConfig={setConfig} />

      <TextField
        label={t('dash.proxyDialTimeoutLabel')}
        value={draft.dialTimeoutSeconds}
        error={issues.dialTimeout}
        placeholder={t('dash.proxyDialTimeoutDefault')}
        onChange={(v) => onChange({ ...draft, dialTimeoutSeconds: v })}
      />

      <div>
        <TextField
          label={t('dash.proxyUrlLabel')}
          value={draftUrl(draft)}
          error={issues.url}
          placeholder="trojan://password@host:443"
          onChange={setUrl}
        />
        <p className="mt-1 text-xs text-fg-subtle">{t('dash.proxyUrlSyncHint')}</p>
      </div>
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
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('dash.proxyUsernameLabel')}
          value={config.username ?? ''}
          onChange={(v) => setConfig({ ...config, username: orUndefined(v) })}
        />
        <TextField
          label={t('dash.proxyPasswordLabel')}
          value={config.password ?? ''}
          onChange={(v) => setConfig({ ...config, password: orUndefined(v) })}
        />
      </div>
    )
  case 'ss':
    return (
      <div className="grid grid-cols-2 gap-3">
        <ChoiceField
          label={t('dash.proxyMethodLabel')}
          value={config.method}
          choices={SS_METHODS}
          onChange={(m) => setConfig({ ...config, method: m })}
        />
        <TextField
          label={t('dash.proxyPasswordLabel')}
          value={config.password}
          error={issues.password}
          onChange={(v) => setConfig({ ...config, password: v })}
        />
      </div>
    )
  case 'ss2022':
    return (
      <div className="grid grid-cols-2 gap-3">
        <ChoiceField
          label={t('dash.proxyMethodLabel')}
          value={config.method}
          choices={SS2022_METHODS}
          onChange={(m) => setConfig({ ...config, method: m })}
        />
        <TextField
          label={t('dash.proxyPskLabel')}
          value={config.passwordBase64}
          error={issues.passwordBase64}
          onChange={(v) => setConfig({ ...config, passwordBase64: v })}
        />
      </div>
    )
  case 'trojan':
    return (
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('dash.proxyPasswordLabel')}
          value={config.password}
          error={issues.password}
          onChange={(v) => setConfig({ ...config, password: v })}
        />
        <TextField
          label={t('dash.proxySniLabel')}
          value={config.sni ?? ''}
          onChange={(v) => setConfig({ ...config, sni: orUndefined(v) })}
        />
      </div>
    )
  case 'vless-tcp':
    return (
      <TextField
        label={t('dash.proxyUuidLabel')}
        value={config.uuid}
        error={issues.uuid}
        onChange={(v) => setConfig({ ...config, uuid: v })}
      />
    )
  case 'vless-ws':
    return (
      <div className="grid grid-cols-3 gap-3">
        <TextField
          label={t('dash.proxyUuidLabel')}
          value={config.uuid}
          error={issues.uuid}
          onChange={(v) => setConfig({ ...config, uuid: v })}
        />
        <TextField
          label={t('dash.proxyWsPathLabel')}
          value={config.path}
          error={issues.path}
          placeholder="/"
          onChange={(v) => setConfig({ ...config, path: v })}
        />
        <TextField
          label={t('dash.proxyWsHostLabel')}
          value={config.wsHost ?? ''}
          onChange={(v) => setConfig({ ...config, wsHost: orUndefined(v) })}
        />
      </div>
    )
  case 'reality':
    return (
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('dash.proxyUuidLabel')}
          value={config.uuid}
          error={issues.uuid}
          onChange={(v) => setConfig({ ...config, uuid: v })}
        />
        <TextField
          label={t('dash.proxyPublicKeyLabel')}
          value={config.publicKey}
          error={issues.publicKey}
          onChange={(v) => setConfig({ ...config, publicKey: v })}
        />
        <TextField
          label={t('dash.proxyServerNameLabel')}
          value={config.serverName}
          error={issues.serverName}
          onChange={(v) => setConfig({ ...config, serverName: v })}
        />
        <TextField
          label={t('dash.proxyShortIdLabel')}
          value={config.shortId ?? ''}
          onChange={(v) => setConfig({ ...config, shortId: orUndefined(v) })}
        />
      </div>
    )
  }
}

import { useId } from "react"
import { useT } from "../../state/i18n"
import { cn } from "../../ui/cn"
import { Select, type SelectOption } from "../../ui/select"
import {
  BACKGROUND_OPTIONS, INPUT_FIDELITY_OPTIONS, OUTPUT_FORMAT_OPTIONS,
  QUALITY_OPTIONS, SIZE_OPTIONS, type ImageParams,
} from "./images"

interface Props {
  params: ImageParams
  onChange: (next: ImageParams) => void
  /** Edits-only controls appear once the composer holds a reference image. */
  editing: boolean
  /** While a reply streams: every select is disabled, for the keyboard too. */
  disabled?: boolean
}

const N_OPTIONS = [1, 2, 3, 4]

/** One labelled parameter. The visible caption names the select (plus its current value). */
function ParamField({ label, value, options, onChange, disabled, className }: {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  className: string
}) {
  const labelId = useId()
  const selectId = `${labelId}-select`
  return (
    <div className="pg-img-param">
      <label id={labelId} htmlFor={selectId} className={disabled ? "opacity-50" : undefined}>{label}</label>
      <div className={className}>
        <Select id={selectId} value={value} onChange={onChange} options={options} labelledBy={labelId} disabled={disabled} size="sm" />
      </div>
    </div>
  )
}

export function ImageParamsBar({ params, onChange, editing, disabled }: Props) {
  const t = useT()
  const set = <K extends keyof ImageParams>(key: K, value: ImageParams[K]) =>
    onChange({ ...params, [key]: value })

  // JPEG has no alpha channel, so a transparent background can't be honoured.
  // Drop the option rather than let the upstream reject the request.
  const formats = params.background === "transparent"
    ? OUTPUT_FORMAT_OPTIONS.filter((f) => f !== "jpeg")
    : OUTPUT_FORMAT_OPTIONS

  const enumField = (
    label: string,
    key: keyof ImageParams,
    options: readonly string[],
  ) => (
    <ParamField
      label={label}
      value={String(params[key])}
      onChange={(v) => set(key, v as never)}
      options={options.map((o) => ({ value: o, label: o === "auto" ? t("dash.playground.imgAuto") : o }))}
      disabled={disabled}
      className="min-w-[104px]"
    />
  )

  return (
    // The selects dim themselves when disabled; only the captions and the mode pill need it here.
    <div className="pg-img-params">
      {enumField(t("dash.playground.imgSize"), "size", SIZE_OPTIONS)}
      {enumField(t("dash.playground.imgQuality"), "quality", QUALITY_OPTIONS)}
      <ParamField
        label={t("dash.playground.imgCount")}
        value={String(params.n)}
        onChange={(v) => set("n", Number(v))}
        options={N_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
        disabled={disabled}
        className="min-w-[64px]"
      />
      {enumField(t("dash.playground.imgBackground"), "background", BACKGROUND_OPTIONS)}
      {enumField(t("dash.playground.imgFormat"), "outputFormat", formats)}
      {editing && enumField(t("dash.playground.imgFidelity"), "inputFidelity", INPUT_FIDELITY_OPTIONS)}
      <span className={cn("pg-img-mode", disabled && "opacity-50")} title={t(editing ? "dash.playground.imgEditHint" : "dash.playground.imgGenerateHint")}>
        {t(editing ? "dash.playground.imgEdit" : "dash.playground.imgGenerate")}
      </span>
    </div>
  )
}

import { useT } from "../../state/i18n"
import { Select } from "../../components/Select"
import {
  BACKGROUND_OPTIONS, INPUT_FIDELITY_OPTIONS, OUTPUT_FORMAT_OPTIONS,
  QUALITY_OPTIONS, SIZE_OPTIONS, type ImageParams,
} from "./images"

interface Props {
  params: ImageParams
  onChange: (next: ImageParams) => void
  /** Edits-only controls appear once the composer holds a reference image. */
  editing: boolean
  disabled?: boolean
}

const N_OPTIONS = [1, 2, 3, 4]

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
    <label className="pg-img-param">
      <span>{label}</span>
      <Select
        value={String(params[key])}
        onChange={(v) => set(key, v as never)}
        options={options.map((o) => ({ value: o, label: o === "auto" ? t("dash.playground.imgAuto") : o }))}
        className="min-w-[104px]"
      />
    </label>
  )

  return (
    <div className={"pg-img-params" + (disabled ? " opacity-50 pointer-events-none" : "")}>
      {enumField(t("dash.playground.imgSize"), "size", SIZE_OPTIONS)}
      {enumField(t("dash.playground.imgQuality"), "quality", QUALITY_OPTIONS)}
      <label className="pg-img-param">
        <span>{t("dash.playground.imgCount")}</span>
        <Select
          value={String(params.n)}
          onChange={(v) => set("n", Number(v))}
          options={N_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          className="min-w-[64px]"
        />
      </label>
      {enumField(t("dash.playground.imgBackground"), "background", BACKGROUND_OPTIONS)}
      {enumField(t("dash.playground.imgFormat"), "outputFormat", formats)}
      {editing && enumField(t("dash.playground.imgFidelity"), "inputFidelity", INPUT_FIDELITY_OPTIONS)}
      <span className="pg-img-mode" title={t(editing ? "dash.playground.imgEditHint" : "dash.playground.imgGenerateHint")}>
        {t(editing ? "dash.playground.imgEdit" : "dash.playground.imgGenerate")}
      </span>
    </div>
  )
}

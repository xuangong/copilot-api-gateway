import { useT } from "../../../state/i18n"
import type * as api from "../../../api/upstreams"
import { SegmentedControl } from "../../../ui/segmented-control"
import { groupFlags } from "../upstream-form-state"
import { FormHeading, sectionHeadingCls } from "./Field"

type FlagState = "inherit" | "on" | "off"

const FLAG_VALUE: Record<FlagState, boolean | null> = { inherit: null, on: true, off: false }

export function FeatureFlagsSection({
  catalog,
  flagOverrideState,
  setFlagOverride,
  isFlagDefault,
}: {
  catalog: api.FlagCatalog["catalog"]
  flagOverrideState: (id: string) => FlagState
  setFlagOverride: (id: string, value: boolean | null) => void
  isFlagDefault: (flagId: string) => boolean
}) {
  const t = useT()
  return (
    <div className="mt-4 border-t border-border pt-3">
      <FormHeading offset={1} className={sectionHeadingCls}>{t("dash.featureFlagsLabel")}</FormHeading>
      <p className="mb-3 text-xs text-fg-subtle">{t("dash.featureFlagsHint")}</p>
      {groupFlags(catalog).map((group) => (
        <div key={group.key} className="mb-4 last:mb-0">
          <FormHeading offset={2} className="mb-2 text-xs font-medium text-fg-muted">
            {t(group.labelKey)}
          </FormHeading>
          <div className="space-y-3">
            {group.flags.map((flag) => {
              return (
                <div key={flag.id} className="flex flex-col gap-2 text-xs sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <div className="font-medium text-fg">{flag.label}</div>
                    <div className="text-fg-subtle">{flag.description}</div>
                  </div>
                  <SegmentedControl<FlagState>
                    size="sm"
                    className="shrink-0 self-start"
                    ariaLabel={flag.label}
                    value={flagOverrideState(flag.id)}
                    onChange={(v) => setFlagOverride(flag.id, FLAG_VALUE[v])}
                    options={[
                      {
                        value: "inherit",
                        label: t("dash.inheritLabel", { val: isFlagDefault(flag.id) ? t("dash.onLabel") : t("dash.offLabel") }),
                      },
                      { value: "on", label: t("dash.flagOn") },
                      { value: "off", label: t("dash.flagOff") },
                    ]}
                  />
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

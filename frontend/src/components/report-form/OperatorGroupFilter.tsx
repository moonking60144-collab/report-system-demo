import { ALL_OPERATOR_GROUP_KEY, type OperatorGroupOption } from "./operatorGroupPreferences";

interface OperatorGroupFilterProps {
  label: string;
  allLabel: string;
  selectedGroupKey: string;
  options: OperatorGroupOption[];
  onChange: (groupKey: string) => void;
  className?: string;
}

export function OperatorGroupFilter({
  label,
  allLabel,
  selectedGroupKey,
  options,
  onChange,
  className,
}: OperatorGroupFilterProps) {
  if (options.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      <span className="operator-group-filter-label">{label}</span>
      <div className="toolbar-segmented" role="group" aria-label={label}>
        <button
          type="button"
          className={selectedGroupKey === ALL_OPERATOR_GROUP_KEY ? "is-active" : undefined}
          onClick={() => onChange(ALL_OPERATOR_GROUP_KEY)}
        >
          {allLabel}
        </button>
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={selectedGroupKey === option.key ? "is-active" : undefined}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

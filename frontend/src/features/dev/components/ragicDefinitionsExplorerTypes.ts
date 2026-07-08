import type {
  RagicDefinitionFormula,
  RagicDefinitionFormDetail,
} from "../../../api/devRagicDefinitions";

export type DetailSearchType = "all" | "field" | "formula" | "workflow";
export type FormField = RagicDefinitionFormDetail["fields"][number];
export type FormWorkflow = RagicDefinitionFormDetail["workflows"][number];
export type SelectedTarget =
  | {
      type: "formula";
      fieldId: string;
      formulaKind: RagicDefinitionFormula["formulaKind"];
    }
  | { type: "field"; fieldId: string }
  | { type: "workflow"; scope: string };

export type FieldMapping = Record<string, string>;

export interface FormWriteConfig {
  subtableId: string;
  requiredFields: string[];
  mainWriteFields?: FieldMapping;
  subtableWriteFields: FieldMapping;
}

export interface LinkedFieldConfig {
  sourceFormPath: string;
  lookupFieldId?: string;
  displayFieldId: string;
}

export type LinkedFieldMapping = Record<string, LinkedFieldConfig>;

export interface FormConfig {
  formId: string;
  formName: string;
  ragicPath: string;
  mainFields: FieldMapping;
  mainFieldFallbacks?: FieldMapping;
  filterFields?: FieldMapping;
  filterFieldFallbacks?: FieldMapping;
  subtableId: string;
  subtableFields: FieldMapping;
  writeConfig: FormWriteConfig;
  linkedFields?: LinkedFieldMapping;
  displayFields: string[];
}

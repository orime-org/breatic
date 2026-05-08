// Credit pack item (one-off purchase, not subscription).
export interface CreditsItemType {
  id: number;
  name: string;
  code: string;
  icon: string | null;
  price: number;
  addonType: string;
  isFirstRecharge: boolean;
  addonValue: number;
  description: string;
}

// Use case item type.
export interface UseCaseItemObjType {
  id: string;
  use_case_name: string;
  use_case_version: string;
  use_case_desc: string;
  content: string | null;
  use_case_screen: string | null;
}


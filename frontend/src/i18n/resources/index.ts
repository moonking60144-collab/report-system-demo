import commonZhTw from "./zh-TW/common";
import commonEn from "./en/common";
import workReportZhTw from "./zh-TW/workReport";
import workReportEn from "./en/workReport";
import itDutyZhTw from "./zh-TW/itDuty";
import itDutyEn from "./en/itDuty";

// NOTE: 新頁面要擴語系時，請在這裡註冊新的 namespace resources。
export const i18nResources = {
  "zh-TW": {
    common: commonZhTw,
    workReport: workReportZhTw,
    itDuty: itDutyZhTw,
  },
  en: {
    common: commonEn,
    workReport: workReportEn,
    itDuty: itDutyEn,
  },
} as const;

export default i18nResources;

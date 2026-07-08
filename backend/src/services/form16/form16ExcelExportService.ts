import axios from "axios";
import { env } from "../../config/env";
import { HttpError } from "../../utils/httpError";

export interface PublishedExport {
  filename: string;
  contentType: string;
  body: Buffer;
}

// 直接抓使用者在 Ragic 做好的「發佈到網路」完整下載網址（view 已自己篩好），原樣轉給前端下載。
// 後端只當 proxy：把含 key 的完整網址藏在 .env，前端／同事按鈕就能拿到檔案、不必看到 key。
// 不在後端再篩月——view 122 就是使用者要的成品。
class Form16ExcelExportService {
  async exportFromPublishedUrl(): Promise<PublishedExport> {
    const url = env.REPORT_EXCEL_CSV.trim();
    if (!url) {
      throw new HttpError(
        503,
        "尚未設定 REPORT_EXCEL_CSV（Ragic 發佈到網路的完整下載網址），無法匯出。請在後端 .env 補上後重啟。",
        "REPORT_EXCEL_CSV_NOT_CONFIGURED"
      );
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new HttpError(
        500,
        "REPORT_EXCEL_CSV 需為完整網址（含 https://、APIKey、view），目前看起來不是網址。",
        "REPORT_EXCEL_CSV_NOT_A_URL"
      );
    }

    let data: ArrayBuffer;
    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        timeout: env.REPORT_EXCEL_CSV_TIMEOUT_MS,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      data = response.data;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new HttpError(502, `抓取 Ragic 發佈網址失敗：${detail}`, "RAGIC_PUBLISHED_FETCH_FAILED");
    }

    const isXlsx = /\.xlsx(\?|$)/i.test(url);
    return {
      filename: isXlsx ? "c1-6-report.xlsx" : "c1-6-report.csv",
      contentType: isXlsx
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv; charset=utf-8",
      body: Buffer.from(data),
    };
  }
}

export const form16ExcelExportService = new Form16ExcelExportService();

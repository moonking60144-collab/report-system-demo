// 匯出功能用的檔案圖示（檔案外框 + 色標 + 小裝飾），自製 SVG、不依賴第三方版權圖。
// 停機紀錄頁工具列、效率統計入口與選單共用。

interface ExportIconProps {
  size?: string;
}

export function CsvIcon({ size = "1.8em" }: ExportIconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
      {/* 檔案主體 + 右上折角 */}
      <path
        d="M8 3h12.5L27 9.5V28a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 7 28V4.5A1.5 1.5 0 0 1 8 3Z"
        fill="#fff"
        stroke="#1f2937"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 3v5A1.5 1.5 0 0 0 22 9.5h5"
        fill="#e5e7eb"
        stroke="#1f2937"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* 綠色 CSV 標籤 */}
      <rect x="2.5" y="9.5" width="15.5" height="8" rx="1.2" fill="#3cb44b" stroke="#1f2937" strokeWidth="1.4" />
      <text
        x="10.2"
        y="15.8"
        fontSize="6.8"
        fontWeight="800"
        fill="#fff"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
      >
        CSV
      </text>
      {/* 表格格線 */}
      <g stroke="#1f2937" strokeWidth="1.3">
        <rect x="11" y="19.5" width="13.5" height="8.5" fill="none" />
        <line x1="11" y1="22.3" x2="24.5" y2="22.3" />
        <line x1="11" y1="25.1" x2="24.5" y2="25.1" />
        <line x1="15.5" y1="19.5" x2="15.5" y2="28" />
        <line x1="20" y1="19.5" x2="20" y2="28" />
      </g>
    </svg>
  );
}

export function XlsxIcon({ size = "1.8em" }: ExportIconProps) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden="true" focusable="false">
      {/* 檔案主體 + 右上折角 */}
      <path
        d="M8 3h12.5L27 9.5V28a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 7 28V4.5A1.5 1.5 0 0 1 8 3Z"
        fill="#fff"
        stroke="#1f2937"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 3v5A1.5 1.5 0 0 0 22 9.5h5"
        fill="#e5e7eb"
        stroke="#1f2937"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* Excel 綠 XLS 標籤 */}
      <rect x="2.5" y="9.5" width="15.5" height="8" rx="1.2" fill="#217346" stroke="#1f2937" strokeWidth="1.4" />
      <text
        x="10.2"
        y="15.8"
        fontSize="6.8"
        fontWeight="800"
        fill="#fff"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
      >
        XLS
      </text>
      {/* 長條圖（樞紐統計意象） */}
      <g fill="#217346" stroke="#1f2937" strokeWidth="1.1">
        <rect x="11.5" y="24" width="3" height="4" />
        <rect x="16" y="21" width="3" height="7" />
        <rect x="20.5" y="18.5" width="3" height="9.5" />
      </g>
    </svg>
  );
}

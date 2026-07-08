import type { ItSopDocument, ItSopSection } from "./itSopDocumentService";

export const CURRENT_IT_SOP_TEMPLATE_VERSION = 4;

function tableSection(id: string, title: string, rows: string[][], collapsed = false): ItSopSection {
  return {
    id,
    title,
    kind: "table",
    text: "",
    rows: rows.map((cells, index) => ({ id: `${id}-${index + 1}`, cells })),
    items: [],
    collapsed,
  };
}

function textSection(id: string, title: string, text: string, collapsed = false): ItSopSection {
  return {
    id,
    title,
    kind: "text",
    text,
    rows: [],
    items: [],
    collapsed,
  };
}

function codeSection(id: string, title: string, text: string, collapsed = false): ItSopSection {
  return {
    id,
    title,
    kind: "code",
    text,
    rows: [],
    items: [],
    collapsed,
  };
}

function checklistSection(id: string, title: string, items: string[], collapsed = false): ItSopSection {
  return {
    id,
    title,
    kind: "checklist",
    text: "",
    rows: [],
    items: items.map((text, index) => ({ id: `${id}-${index + 1}`, text, checked: false })),
    collapsed,
  };
}

export function createDefaultItSopDocument(documentId: string): ItSopDocument {
  return {
    id: documentId,
    title: "新電腦設置",
    summary:
      "這份 SOP 用於公司 Windows 新電腦設置。依序完成資產登記、電腦命名、網路與網域、共用槽、必要軟體、印表機、使用者層級軟體與交付驗收；帳號密碼不寫入文件，依公司密碼保存方式處理。",
    templateVersion: CURRENT_IT_SOP_TEMPLATE_VERSION,
    updatedAt: new Date(0).toISOString(),
    updatedByLabel: null,
    sections: [
      tableSection("sop-data", "SOP 資料", [
        ["欄位", "填寫內容"],
        ["適用範圍", "公司 Windows 11 新電腦、重灌後交付、部門換機。"],
        ["主要目標", "讓新電腦完成資產登記、加入網域、掛載共用槽、安裝必要軟體與印表機，並可交付使用者。"],
        ["執行者", "IT / MIS 人員。"],
        ["資料安全", "本 SOP 不存放帳號密碼、授權金鑰、個資清單；密碼與金鑰依公司保管方式處理。"],
        ["完成定義", "使用者可登入、網路與共用槽可用、必要軟體可開、印表機可列印、交付清單完成。"],
      ]),
      tableSection("step-1-assets", "第一步、開箱與資產登記", [
        ["項目", "要做什麼", "確認方式"],
        ["確認硬體", "記錄品牌、型號、CPU、RAM、SSD、主機板、序號與 MAC Address。", "用 PowerShell 查詢，並與機殼貼紙 / 採購資料核對。"],
        ["建立資產資料", "在資產或財產系統建立資產編號、位置、使用部門、保管人與設備名稱。", "資產編號與電腦名稱可追溯。"],
        ["決定電腦名稱", "依公司命名規則命名，例如 WK-部門-PC-流水號。", "避免與既有 AD / DNS / DHCP 記錄重複。"],
        ["準備安裝來源", "把需要提權安裝的檔案先複製到本機 C:\\ProgramData\\FDS\\Installers。", "不要直接用使用者 session 的 L: 路徑提權安裝。"],
      ]),
      codeSection(
        "asset-commands",
        "第一步指令、硬體與身分查詢",
        String.raw`$cs = Get-CimInstance Win32_ComputerSystem
$csp = Get-CimInstance Win32_ComputerSystemProduct
$cpu = Get-CimInstance Win32_Processor
$bios = Get-CimInstance Win32_BIOS
$disk = Get-PhysicalDisk
$baseBoard = Get-CimInstance Win32_BaseBoard

"電腦名稱: $env:COMPUTERNAME"
"目前身分: $(whoami)"
"使用者 Profile: $env:USERPROFILE"
"品牌: $($csp.Vendor)"
"型號: $($csp.Name)"
"BIOS 序號: $($bios.SerialNumber)"
"CPU: $($cpu.Name)"
"RAM: $([math]::Round($cs.TotalPhysicalMemory / 1GB))GB"
"磁碟: $(($disk | ForEach-Object { "$($_.FriendlyName) / $([math]::Round($_.Size / 1GB))GB" }) -join '; ')"
"主機板: $($baseBoard.Manufacturer) $($baseBoard.Product)"
getmac /v`
      ),
      tableSection("step-2-windows", "第二步、Windows 基礎設定", [
        ["項目", "要做什麼", "注意事項"],
        ["Windows Update", "先跑更新並重開到沒有必要更新。", "避免 driver / .NET / Office 安裝時遇到舊元件問題。"],
        ["電腦名稱", "依資產命名規則改名後重開。", "改名前先確認名稱沒有被 AD 或 DNS 使用。"],
        ["時區與語言", "確認時區、輸入法、顯示語言與日期格式。", "台灣環境一般使用 zh-TW 與 Taipei 時區。"],
        ["本機管理", "確認 IT 管理帳號可提權，並保留必要本機管理入口。", "不要把一般使用者帳密寫入 SOP。"],
      ]),
      tableSection("step-3-network-domain", "第三步、網路、固定 IP 與網域", [
        ["項目", "要做什麼", "確認方式"],
        ["IP 配置", "依公司規則設定 DHCP 綁定或固定 IP。", "ipconfig /all 顯示正確 IP、Gateway、DNS。"],
        ["DNS", "DNS 必須指向公司 DNS。", "nslookup / nltest 可找到網域控制站。"],
        ["加入網域", "加入 fds.local 或公司指定網域後重開。", "用實際網域帳號登入並確認 whoami。"],
        ["網路連通", "確認檔案伺服器、共用槽、印表機 IP 可達。", "Test-NetConnection 對 445 / 9100 做基本檢查。"],
      ]),
      codeSection(
        "network-commands",
        "第三步指令、網路與網域查驗",
        String.raw`ipconfig /all
whoami
nslookup fds.local
nltest /dsgetdc:fds.local
nltest /sc_query:fds.local
Test-NetConnection <檔案伺服器IP> -Port 445
Test-NetConnection <印表機IP> -Port 9100`
      ),
      tableSection("step-4-shared-drives", "第四步、共用槽與 linkDisk", [
        ["項目", "要做什麼", "確認方式"],
        ["共用槽清單", "確認部門需要的 K/L/M/Z/U 等磁碟機與 UNC 路徑。", "以 net use 確認掛載結果。"],
        ["SMB 相容性", "舊伺服器若需要 SMB1，只啟用 SMB1 Client。", "不要啟用 SMB1 Server。"],
        ["linkDisk", "把標準 linkDisk 腳本放到 C:\\ProgramData\\FDS\\Scripts。", "捷徑放 C:\\Users\\Public\\Desktop 供所有使用者使用。"],
        ["提權限制", "提權後看不到使用者 session 的網路磁碟是正常現象。", "安裝檔優先使用本機路徑或 UNC。"],
      ]),
      codeSection(
        "shared-drive-commands",
        "第四步指令、共用槽查驗",
        String.raw`# 查共用槽
net use

# 查 SMB1 Client
Get-WindowsOptionalFeature -Online -FeatureName SMB1Protocol-Client

# 必要時只啟用 SMB1 Client
Enable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol-Client -All

# 建立全域 linkDisk 捷徑範例
New-Item -ItemType Directory -Path "C:\ProgramData\FDS\Scripts" -Force
Copy-Item "<linkDisk來源路徑>" "C:\ProgramData\FDS\Scripts\=linkDisk.bat" -Force
$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut("C:\Users\Public\Desktop\=linkDisk.lnk")
$s.TargetPath = "C:\ProgramData\FDS\Scripts\=linkDisk.bat"
$s.WorkingDirectory = "C:\ProgramData\FDS\Scripts"
$s.Save()`
      ),
      tableSection("step-5-software", "第五步、必要軟體安裝", [
        ["類別", "軟體 / 元件", "安裝原則"],
        ["Office", "Microsoft 365 / Office 指定版本", "依部門授權安裝，不混裝未授權版本。"],
        ["瀏覽器", "Firefox / Chrome / Edge", "至少確認公司常用系統可登入。"],
        ["標籤列印", "BarTender、ACE OLEDB / Access Database Engine", "BarTender 讀 Excel/Access 資料來源時常需要 ACE OLEDB。"],
        ["郵件 / 通訊", "Zoho Mail Desktop、LINE", "LINE 常是使用者層級軟體，需在實際使用者帳號下安裝。"],
        ["標籤設計", "GoLabel II", "只有需要開 .ezpx 或 GoDEX 標籤檔時安裝。"],
        ["舊系統入口", "MIS / ERP / 公司內部捷徑", "確認目前有效入口，不直接複製舊機失效捷徑。"],
      ]),
      codeSection(
        "software-check-command",
        "第五步指令、已安裝軟體查詢",
        String.raw`Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                 "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*" |
Where-Object { $_.DisplayName -match "Office|BarTender|Access|Firefox|Chrome|Zoho|LINE|GoLabel" } |
Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation |
Format-Table -AutoSize`
      ),
      tableSection("step-6-printers", "第六步、印表機與標籤機", [
        ["項目", "要做什麼", "確認方式"],
        ["一般印表機", "安裝部門常用事務機 driver，使用固定 TCP/IP port。", "列印測試頁，確認不是 WSD / IPP 自動抓錯機型。"],
        ["點陣印表機", "安裝指定型號 driver 與正確 IP port。", "測試報表或連續紙列印。"],
        ["標籤機", "安裝正確型號 driver，例如 GE300 不能用 G300 代替。", "用 BarTender 或標籤檔測試列印。"],
        ["預設印表機", "依部門習慣設定預設印表機。", "避免使用者誤選多餘 WSD 印表機。"],
      ]),
      codeSection(
        "printer-check-command",
        "第六步指令、印表機查驗",
        String.raw`Get-Printer |
Select-Object Name, DriverName, PortName, Default |
Sort-Object Name |
Format-Table -AutoSize

Get-PrinterPort |
Where-Object { $_.PrinterHostAddress } |
Select-Object Name, PrinterHostAddress, PortNumber |
Format-Table -AutoSize

Test-NetConnection <印表機IP> -Port 9100`
      ),
      tableSection("step-7-user-profile", "第七步、使用者帳號與 Profile", [
        ["項目", "要做什麼", "注意事項"],
        ["首次登入", "用實際使用者網域帳號登入一次，建立正式 Profile。", "不要把管理員 Profile 當成使用者 Profile。"],
        ["桌面捷徑", "共用捷徑放 Public Desktop；個人捷徑才放使用者 Desktop。", "補捷徑前先確認程式本體存在。"],
        ["AppData 軟體", "LINE 等使用者層級軟體在實際帳號下安裝。", "提權可能裝到 IT 管理員的 AppData。"],
        ["瀏覽器與郵件", "確認公司常用網站、郵件、Ragic / ERP 入口可開。", "登入資訊由使用者或管理流程處理，不寫入 SOP。"],
      ]),
      checklistSection("handoff-checklist", "第八步、交付前驗收清單", [
        "資產編號、電腦名稱、位置、使用部門已登記。",
        "電腦名稱符合公司命名規則。",
        "Windows Update 已完成並重開。",
        "網路 IP、Gateway、DNS 正確。",
        "已加入公司網域，實際使用者可登入。",
        "共用槽或 linkDisk 可正常掛載。",
        "Office 可開啟並完成授權或登入。",
        "瀏覽器可開啟公司內部系統。",
        "BarTender / ACE OLEDB 依需求可用。",
        "LINE / Zoho / GoLabel 依使用者需求處理。",
        "一般印表機、點陣印表機、標籤機完成測試列印。",
        "多餘 WSD / IPP 自動印表機已移除或標記不用。",
        "MIS / ERP / Ragic 等入口已確認可用。",
        "交付使用者前已說明密碼、共用槽、印表機與常用系統入口。",
      ]),
      tableSection("troubleshooting", "第九步、常見問題排查", [
        ["症狀", "可能原因", "處理方向"],
        ["提權安裝找不到 L: 磁碟", "UAC 提權後看不到使用者 session 的網路磁碟。", "把安裝檔複製到本機，或改用 UNC 路徑。"],
        ["共用槽連不上但 ping 會通", "SMB / 權限 / 舊協定問題。", "測 445 port、確認帳號、必要時只開 SMB1 Client。"],
        ["BarTender 讀不到 Excel/Access", "缺 ACE OLEDB 或位元版本不符。", "安裝 Access Database Engine，確認 BarTender 位元需求。"],
        ["標籤機無法列印", "driver 型號或 port 錯。", "確認 driver 與標籤檔指定型號一致，測 9100 port。"],
        ["LINE 不見", "裝在其他使用者 AppData。", "用實際使用者帳號重新安裝。"],
      ]),
      codeSection(
        "common-commands",
        "第十步、常用指令總表",
        String.raw`# 身分 / Profile
whoami
echo $env:USERPROFILE

# 網路 / 網域
ipconfig /all
nslookup fds.local
nltest /dsgetdc:fds.local
nltest /sc_query:fds.local

# 共用槽
net use
Test-NetConnection <檔案伺服器IP> -Port 445

# 印表機
Get-Printer | Select-Object Name, DriverName, PortName, Default | Sort-Object Name | Format-Table -AutoSize

# 軟體
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                 "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*" |
Select-Object DisplayName, DisplayVersion, InstallLocation |
Sort-Object DisplayName`
      ),
    ],
  };
}

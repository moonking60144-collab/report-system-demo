import { meetingMinutesParagraphs } from "./meetingMinutesParagraphs";

export const meetingMinutesSignature = '<section id="signatures" class="section"><h2>簽名</h2><div class="signature-line" aria-label="與會者簽名空白欄"></div></section>';

export const meetingMinutesDocumentStyles = `
:root{color-scheme:light;--bg:#ececea;--paper:#fff;--ink:#202020;--muted:#595959;--line:#c9c9c5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;font-size:15px;line-height:1.85;overflow-wrap:anywhere}
.page{width:210mm;max-width:calc(100% - 32px);min-height:297mm;margin:24px auto;padding:18mm 17mm;background:var(--paper)}
h1,h2,h3{color:var(--ink);line-height:1.5}h1{font-family:"Noto Serif TC","Songti TC","PMingLiU",serif;font-size:25px;font-weight:700;letter-spacing:.025em;margin:0 0 12px}h2{font-size:18px;margin:0 0 14px;padding-bottom:7px;border-bottom:1px solid var(--line)}h3{font-size:16px;margin:0 0 6px}p{margin:8px 0}
.document-header{padding:0 0 22px;border-bottom:1px solid var(--ink);margin-bottom:26px}.subtitle{color:var(--muted);font-size:13px;margin:6px 0}.meta{display:flex;flex-wrap:wrap;gap:8px 28px;border-top:1px solid var(--line);padding-top:12px;margin-top:18px;font-size:12px;font-variant-numeric:tabular-nums}.meta strong{font-weight:500;color:var(--muted);margin-right:8px}.summary{margin-top:18px}.summary p{margin:8px 0}
.layout,main{display:block;min-width:0}nav{display:none}.section{padding:0;margin:0 0 28px;scroll-margin-top:16px}.attendees{margin:0}.attendees div{display:flex;gap:16px;padding:5px 0}.attendees dt{flex:0 0 90px;color:var(--muted)}.attendees dd{margin:0}
.topic{padding:0 0 16px;margin:0 0 16px;border-bottom:1px solid var(--line)}.topic:last-child{border:0;margin-bottom:0;padding-bottom:0}.topic-no{float:left;min-width:24px;margin-right:8px;font-size:16px;font-weight:700}.topic-no::after{content:"."}.topic-body p{margin:7px 0}.topic-label{font-weight:600;margin-right:10px}.direction{margin-top:10px}.numbered-list{padding-left:24px;margin:0}.numbered-list li{padding:0 0 12px}.numbered-list p{margin:0}.numbered-list small{color:var(--muted);font-size:12px}
.topic-field{margin-top:16px}.topic-field .topic-label{display:block;margin:0 0 4px;font-size:13px;font-weight:500;color:var(--muted);line-height:1.6}.topic-field p{margin:0 0 12px}.topic-field p:last-child{margin-bottom:0}.topic-body h3{margin-bottom:12px}.topic-field:last-child{margin-bottom:4px}
.rows{display:block}.row{padding:10px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}.row p{margin:0}.row small{display:block;color:var(--muted);font-size:12px;margin-top:3px}.terms{padding-left:20px;columns:2}.terms li{padding:2px 0}.empty{color:var(--muted);font-size:13px}.footer{border-top:1px solid var(--line);margin-top:32px;padding-top:10px;color:var(--muted);font-size:11px}
.audio-item{padding:12px 0}.audio-item small{display:block;color:var(--muted)}audio{display:block;width:100%;margin:8px 0}.file-fallback,.audio-status{font-size:12px;color:var(--muted)}.file-fallback input{display:block;max-width:100%;margin-top:8px}
.signature-line{height:16mm;border-bottom:1px solid var(--line)}#signatures{break-inside:avoid-page}
@media screen and (max-width:600px){.page{max-width:100%;width:100%;margin:0;padding:24px 20px;min-height:100vh}h1{font-size:22px}.meta{gap:6px 16px}.attendees div{display:block}.terms{columns:1}}
@page{size:A4 portrait;margin:16mm 17mm 18mm}
@media print{
 :root{color-scheme:light}html,body{background:#fff;color:#000;font-size:11pt;line-height:1.7}.page{width:auto;max-width:none;min-height:0;margin:0;padding:0;background:#fff}
 h1{font-size:19pt}h2{font-size:13pt}h3{font-size:11.5pt}.subtitle,.meta,.empty{font-size:9pt}.document-header{margin-bottom:4mm;padding-bottom:4mm}.document-header .meta,.document-header .summary{margin-top:3mm}.section{margin-bottom:5mm;break-inside:auto}h2{margin-bottom:3mm;padding-bottom:2mm}.topic{display:block;break-inside:auto;padding-bottom:3mm;margin-bottom:3mm}.topic-no{float:left}.topic-body{display:block}.topic-body h3{display:block}h1,h2,h3,h4{break-after:avoid-page}.topic-field{margin-top:2mm}.topic-field .topic-label{font-size:9pt}.topic-field p{margin-bottom:2mm}p{orphans:3;widows:3}.row,.attendees div,.numbered-list li{break-inside:avoid-page}nav,audio,.file-fallback,.audio-status{display:none!important}.audio-item{padding:2mm 0}.terms{columns:1}.signature-line{height:14mm}.footer{font-size:8pt;margin-top:4mm}a{color:inherit;text-decoration:none}
}`;

// Only fixed-template markup is adapted; archived text stays HTML-escaped.
export function restyleMeetingMinutesHtml(html: string): string {
  if (!html.includes('class="document-header"') || !html.includes('id="topics"')) return html;
  let document = html.replace(/<style>[\s\S]*?<\/style>/, () => `<style>${meetingMinutesDocumentStyles}</style>`)
    .replace(/<p(?: class="direction")?><span class="topic-label">(現況問題|討論內容|目前方向)<\/span>([^<]*)<\/p>/g,
      (_match, label: string, text: string) => `<div class="topic-field"><h4 class="topic-label">${label}</h4>${meetingMinutesParagraphs(text).map(paragraph => `<p>${paragraph}</p>`).join("")}</div>`)
    .replace('name="color-scheme" content="light dark"', 'name="color-scheme" content="light"');
  document = document.replace(/<section id="(requirements|actions)" class="section">[\s\S]*?<\/section>/g,
    section => section.replace(/<small>(?:責任單位：|負責：)[^<]*(?:<br>(期限：[^<]*))?<\/small>/g,
      (_match, dueDate: string | undefined) => dueDate ? `<small>${dueDate}</small>` : ""));
  if (!document.includes('id="signatures"')) {
    document = document.replace(/<div class="signature-line">[\s\S]*?<\/div>/g, "")
      .replace(/<section id="attendees" class="section">[\s\S]*?<\/section>/, meetingMinutesSignature)
      .replace('<a href="#attendees">出席人員</a>', '<a href="#signatures">簽名</a>');
  }
  return document;
}

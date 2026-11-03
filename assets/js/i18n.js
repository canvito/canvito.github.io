// Interface language: English (default) or Vietnamese, chosen with the switch in the top bar.
// English strings are their own keys: t('Read the entry →') returns the Vietnamese text when Vietnamese is on,
// and falls back to English for anything not translated. Entries may carry an optional Vietnamese version
// (post.vi = { title, summary, body }); loc() picks it when Vietnamese is on and falls back to English.
const KEY = 'canvito.lang';
export const LANGS = { en: 'English', vi: 'Tiếng Việt' };
export let lang = localStorage.getItem(KEY) === 'vi' ? 'vi' : 'en';
document.documentElement.lang = lang;

const listeners = new Set();
export const onLangChange = (fn) => listeners.add(fn);
export function setLang(l) {
  if (!LANGS[l] || l === lang) return;
  lang = l;
  localStorage.setItem(KEY, l);
  document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}
export const locale = () => (lang === 'vi' ? 'vi-VN' : 'en-US');

export function t(en, vars) {
  let s = lang === 'vi' && VI[en] !== undefined ? VI[en] : en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}

// A post or index entry field in the current language (Vietnamese version when present, else English).
export const loc = (o, field) => (lang === 'vi' && o?.vi?.[field]?.trim() ? o.vi[field] : o?.[field] || '');
export const hasVi = (o) => !!(o?.vi?.title?.trim() || o?.vi?.body?.trim());

// Site title/byline: config.json "i18n": { "vi": { "title", "byline" } } overrides for Vietnamese.
export const cfgText = (cfg, field) => (lang === 'vi' && cfg?.i18n?.vi?.[field]) || cfg?.[field] || '';

const VI = {
  // chrome
  'Skip to content': 'Bỏ qua, đến nội dung',
  'Front Page': 'Trang nhất',
  Journal: 'Nhật ký',
  Threads: 'Chủ đề',
  Guestbook: 'Sổ lưu bút',
  About: 'Giới thiệu',
  'Search the journal…   /': 'Tìm trong nhật ký…   /',
  Search: 'Tìm kiếm',
  'Opening the journal…': 'Đang mở nhật ký…',
  '🚧 Under construction — more chapters coming soon.': '🚧 Đang xây dựng — sắp có thêm nhiều chương mới.',
  'Toggle the lamp': 'Bật/tắt đèn',
  'Toggle dark mode': 'Chuyển chế độ tối',
  Language: 'Ngôn ngữ',
  'Vol. {v} · No. {n}': 'Tập {v} · Số {n}',
  Author: 'Tác giả',
  Lock: 'Khóa',
  Guest: 'Khách',
  'ends {when}': 'hết hạn {when}',
  'Access ends {date}': 'Quyền truy cập hết hạn lúc {date}',
  Leave: 'Rời đi',
  Unlock: 'Mở khóa',
  'Journal locked.': 'Đã khóa nhật ký.',
  'Something went wrong: {msg}': 'Đã xảy ra lỗi: {msg}',
  'The journal could not be opened: {msg}': 'Không mở được nhật ký: {msg}',
  Close: 'Đóng',
  // unlock
  'Unlock the journal': 'Mở khóa nhật ký',
  'Enter the access code you were given.': 'Nhập mã truy cập bạn đã nhận được.',
  'Access code': 'Mã truy cập',
  'Checking…': 'Đang kiểm tra…',
  'Welcome back. Everything is unsealed.': 'Chào mừng trở lại. Mọi thứ đã được mở.',
  'Welcome{name}. Protected entries are now visible.': 'Chào mừng{name}. Bạn đã có thể xem các bài được bảo vệ.',
  'Author sign-in on a new device': 'Tác giả đăng nhập trên thiết bị mới',
  Passphrase: 'Cụm mật khẩu',
  'GitHub token (both repos, Contents read/write)': 'GitHub token (cả hai repo, quyền Contents đọc/ghi)',
  'Sign in &amp; remember this device': 'Đăng nhập &amp; ghi nhớ thiết bị này',
  'Welcome back. This device will remember you; next time just use your passphrase.': 'Chào mừng trở lại. Thiết bị này sẽ ghi nhớ bạn; lần sau chỉ cần cụm mật khẩu.',
  'Enter your access code': 'Hãy nhập mã truy cập',
  'That code was not recognized.': 'Mã này không hợp lệ.',
  'That code was not recognized. (Author on a new device? Use “Author sign-in on a new device” below.)':
    'Mã này không hợp lệ. (Là tác giả trên thiết bị mới? Hãy dùng “Tác giả đăng nhập trên thiết bị mới” bên dưới.)',
  'Wrong passphrase.': 'Sai cụm mật khẩu.',
  'Invalid or expired code': 'Mã không hợp lệ hoặc đã hết hạn',
  'Too many attempts. Please wait a while and try again.': 'Thử quá nhiều lần. Vui lòng đợi một lúc rồi thử lại.',
  'Please complete the human check': 'Vui lòng hoàn tất bước xác minh',
  'Human check failed — please try again': 'Xác minh không thành công — vui lòng thử lại',
  'Your access has expired': 'Quyền truy cập của bạn đã hết hạn',
  'This access code is no longer valid': 'Mã truy cập này không còn hiệu lực',
  'Could not reach the access service.': 'Không kết nối được với dịch vụ truy cập.',
  'Name and message are required': 'Vui lòng nhập tên và lời nhắn',
  'Too many links in message': 'Lời nhắn có quá nhiều liên kết',
  // idle lock
  'Still there?': 'Bạn vẫn còn đó chứ?',
  'The journal locks in <b id="idle-left">{n}</b> seconds to keep your entries safe.': 'Nhật ký sẽ tự khóa sau <b id="idle-left">{n}</b> giây để giữ an toàn.',
  'Keep working': 'Tiếp tục',
  'Lock now': 'Khóa ngay',
  'Locked after inactivity. Unlock again with your passphrase.': 'Đã khóa do không hoạt động. Hãy mở lại bằng cụm mật khẩu.',
  // kinds & tiers
  Learned: 'Đã học',
  Gave: 'Đã cho',
  Reflection: 'Suy ngẫm',
  Milestone: 'Cột mốc',
  Artifact: 'Kỷ vật',
  Page: 'Trang',
  LEARNED: 'ĐÃ HỌC',
  GAVE: 'ĐÃ CHO',
  REFLECTED: 'SUY NGẪM',
  MILESTONE: 'CỘT MỐC',
  ARTIFACT: 'KỶ VẬT',
  PAGE: 'TRANG',
  public: 'công khai',
  protected: 'được bảo vệ',
  private: 'riêng tư',
  'Private — only you': 'Riêng tư — chỉ mình bạn',
  'Protected — shared by code': 'Được bảo vệ — chia sẻ bằng mã',
  // front page
  'On this day': 'Ngày này năm xưa',
  '{date}, across the years': '{date}, qua các năm',
  '{n}y ago': '{n} năm trước',
  'Read the entry →': 'Đọc bài →',
  'Volume I': 'Tập I',
  'The first page is still blank.': 'Trang đầu tiên vẫn còn trống.',
  'Every journey of learning begins with a single entry.': 'Mọi hành trình học hỏi đều bắt đầu từ một trang viết.',
  Reflections: 'Suy ngẫm',
  Milestones: 'Cột mốc',
  'Learn / Give balance': 'Cân bằng Học / Cho',
  'Learn {p}%': 'Học {p}%',
  'Give {p}%': 'Cho {p}%',
  'The Year in Ink': 'Một năm qua nét mực',
  'Full journal →': 'Toàn bộ nhật ký →',
  'Latest Entries': 'Bài mới nhất',
  'All {n} →': 'Tất cả {n} →',
  'All threads →': 'Tất cả chủ đề →',
  '{date} · {n} entry': '{date} · {n} bài',
  '{date} · {n} entries': '{date} · {n} bài',
  // journal
  Years: 'Năm',
  'Sometime this year': 'Trong năm',
  All: 'Tất cả',
  Clear: 'Xóa lọc',
  '{n} entry': '{n} bài',
  '{n} entries': '{n} bài',
  ' for “{q}”': ' cho “{q}”',
  'Nothing matches — try fewer words.': 'Không tìm thấy — hãy thử ít từ hơn.',
  'No entries yet.': 'Chưa có bài nào.',
  // article
  'This entry may be sealed. If you have an access code, unlock the journal above.': 'Bài này có thể đã được niêm phong. Nếu bạn có mã truy cập, hãy mở khóa ở phía trên.',
  'Unsealing…': 'Đang mở niêm phong…',
  '{n} min read': '{n} phút đọc',
  Edit: 'Sửa',
  'Edit this page': 'Sửa trang này',
  '← Newer': '← Mới hơn',
  'Older →': 'Cũ hơn →',
  'No Vietnamese version yet — showing the English original.': 'Chưa có bản tiếng Việt — đang hiển thị bản tiếng Anh.',
  // threads
  '{n} threads': '{n} chủ đề',
  '{n} thread': '{n} chủ đề',
  'No threads yet — add tags to entries.': 'Chưa có chủ đề nào — hãy gắn thẻ cho các bài.',
  'By Kind': 'Theo loại',
  // about
  'This site counts visits anonymously.': 'Trang này đếm lượt truy cập một cách ẩn danh.',
  Colophon: 'Lời ngỏ',
  'About this journal': 'Về cuốn nhật ký này',
  'A single home for a lifetime of learning and giving.': 'Một mái nhà cho cả một đời học hỏi và cho.',
  'This is the source of truth for my journey: the things I have learned, the things I have given, and the artifacts collected along the way. My motto: Learn, Give, Love, Laugh.':
    'Đây là nơi lưu giữ chân thực hành trình của tôi: những điều tôi đã học, những điều tôi đã cho, và những kỷ vật góp nhặt trên đường. Phương châm của tôi: Học, Cho, Yêu, Cười.',
  'Some pages are open to everyone. Some are <strong>protected</strong> and readable by people I give an access code to. Some are <strong>private</strong> and kept only for me. Sealed pages stay encrypted until the right key opens them, both here and in the repository behind the site.':
    'Có những trang mở cho tất cả mọi người. Có những trang <strong>được bảo vệ</strong>, chỉ những ai tôi trao mã truy cập mới đọc được. Có những trang <strong>riêng tư</strong>, chỉ dành cho riêng tôi. Các trang niêm phong luôn được mã hóa cho đến khi được mở bằng đúng chìa khóa, cả ở đây lẫn trong kho lưu trữ phía sau trang.',
  'If you have an access code, use the <em>Unlock</em> button at the top of the page. If you\'d like to say hello, please sign the <a href="#/guestbook">guestbook</a>.':
    'Nếu bạn có mã truy cập, hãy bấm nút <em>Mở khóa</em> ở đầu trang. Nếu muốn gửi lời chào, mời bạn ký vào <a href="#/guestbook">sổ lưu bút</a>.',
  // not found
  'This page is missing or sealed.': 'Trang này không tồn tại hoặc đã được niêm phong.',
  'It may have moved, or it may be locked.': 'Có thể trang đã được chuyển đi, hoặc đang bị khóa.',
  'Back to the journal': 'Quay lại nhật ký',
  // guestbook
  'The Guestbook': 'Sổ lưu bút',
  'Sign it, leave a note, say hello': 'Ký tên, để lại lời nhắn, gửi lời chào',
  'Leave your mark': 'Để lại dấu ấn',
  'Dear {name},': 'Gửi {name},',
  'Your name': 'Tên của bạn',
  'Where are you from? (optional)': 'Bạn đến từ đâu? (không bắt buộc)',
  Message: 'Lời nhắn',
  'Private note (only {name} can read it)': 'Lời nhắn riêng (chỉ {name} đọc được)',
  'Sign the guestbook': 'Ký sổ lưu bút',
  'Notes appear after a quick review.': 'Lời nhắn sẽ hiện sau khi được duyệt.',
  'The guestbook opens once the access service is deployed.': 'Sổ lưu bút sẽ mở khi dịch vụ truy cập sẵn sàng.',
  'Gathering notes…': 'Đang tải lời nhắn…',
  'No signatures yet. Be the first.': 'Chưa có ai ký tên. Hãy là người đầu tiên.',
  'No signatures yet.': 'Chưa có ai ký tên.',
  'Thank you! Your note will appear after review.': 'Cảm ơn bạn! Lời nhắn sẽ hiện sau khi được duyệt.',
  'Thank you for signing!': 'Cảm ơn bạn đã ký tên!',
  // dialogs
  'Are you sure?': 'Bạn chắc chứ?',
  Cancel: 'Hủy',
};

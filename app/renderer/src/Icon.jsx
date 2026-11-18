// SPDX-License-Identifier: GPL-3.0-or-later
// The one place that imports the icon set: Lucide (lucide-react, ISC), compiled into
// the bundle by Vite, so it works offline without any extra file. The rest of the renderer names
// icons by their role; swapping the set means changing this file only.
// Size, stroke and color come from theme.css (the .icon classes override the SVG attributes).
import {
  Archive,
  ArrowDown,
  ArrowDownAZ,
  ArrowLeft,
  ArrowUp,
  Baseline,
  Bold,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  Download,
  EllipsisVertical,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileCode,
  FilterX,
  Folder,
  FolderInput,
  Forward,
  Image,
  Inbox,
  Info,
  Italic,
  Link,
  List,
  ListOrdered,
  Lock,
  Mail,
  MailOpen,
  Menu,
  Minus,
  OctagonAlert,
  Paperclip,
  Pencil,
  Quote,
  Rows3,
  RemoveFormatting,
  Plus,
  Reply,
  ReplyAll,
  RotateCw,
  Save,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  SquareCheck,
  Star,
  Trash2,
  TriangleAlert,
  Underline,
  UserRound,
  X,
  BookUser,
  UserPlus,
  Upload,
  PenLine,
} from 'lucide-react'

// Our own glyphs, drawn on Lucide's grid and with its attributes (24 x 24, stroke 2, round ends), so they sit with the set.
// The reader-pane layouts: a window frame, the list as lines; the reader's pane is the empty part beside or below a divider.
function ownGlyph(slug, shapes) {
  function Glyph({ className = '', ...rest }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`own-${slug}${className ? ` ${className}` : ''}`}
        {...rest}
      >
        {shapes}
      </svg>
    )
  }
  Glyph.displayName = `OwnIcon(${slug})`
  return Glyph
}
// no reader pane: the list fills the frame (the message opens in its place)
const LayoutNone = ownGlyph(
  'layout-none',
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h10M7 12.5h10M7 16h6" />
  </>,
)
// the reader on the right: a vertical divider, the list's lines on the left
const LayoutRight = ownGlyph(
  'layout-right',
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
    <path d="M6.5 9h2M6.5 12.5h2M6.5 16h2" />
  </>,
)
// the reader at the bottom: a horizontal divider, the list's lines on top
const LayoutBottom = ownGlyph(
  'layout-bottom',
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 13h18" />
    <path d="M7 8.5h10" />
  </>,
)

/** Role name -> Lucide component. The first block is the plan's 3.3 list. */
export const ICONS = {
  compose: Pencil,
  inbox: Inbox,
  starred: Star,
  sent: Send,
  scheduled: Clock,
  drafts: File,
  trash: Trash2,
  junk: OctagonAlert,
  archive: Archive,
  folder: Folder,
  refresh: RotateCw,
  checkbox: Square,
  checkboxChecked: SquareCheck,
  markRead: MailOpen,
  markUnread: Mail,
  move: FolderInput,
  more: EllipsisVertical,
  attachment: Paperclip,
  reply: Reply,
  replyAll: ReplyAll,
  forward: Forward,
  back: ArrowLeft,
  search: Search,
  filters: SlidersHorizontal,
  lock: Lock,
  settings: Settings,
  account: UserRound,
  download: Download,
  open: ExternalLink,
  images: Image,
  close: X,
  send: Send,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  list: List,
  listOrdered: ListOrdered,
  link: Link,
  // additions
  star: Star,
  save: Save,
  menu: Menu,
  formatToggle: Baseline,
  quote: Quote,
  clearFormat: RemoveFormatting,
  brand: Mail,
  check: Check,
  minus: Minus,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  plus: Plus,
  show: Eye,
  hide: EyeOff,
  copy: Copy,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
  // 0.10.1
  filterClear: FilterX,
  sortAsc: ArrowUp,
  sortDesc: ArrowDown,
  // the source view
  headers: Rows3,
  source: FileCode,
  // the address book
  contacts: BookUser,
  addContact: UserPlus,
  upload: Upload,
  edit: PenLine,
  // the reader-pane layouts (own glyphs, above)
  layoutNone: LayoutNone,
  layoutRight: LayoutRight,
  layoutBottom: LayoutBottom,
  // the manual order of the accounts and folders
  moveUp: ArrowUp,
  moveDown: ArrowDown,
  sortAlpha: ArrowDownAZ,
}

/**
 * <Icon name="inbox" /> -- decorative by default (aria-hidden); pass `label` when the icon alone
 * carries meaning (then role="img" + aria-label). size: "s" (18 px) or "m" (20 px).
 */
export function Icon({ name, size = 's', label, filled = false, className = '' }) {
  const Glyph = ICONS[name]
  if (!Glyph) throw new Error(`unknown icon: ${name}`)
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true', focusable: 'false' }
  return <Glyph className={`icon icon-${size}${filled ? ' icon-filled' : ''}${className ? ` ${className}` : ''}`} data-icon={name} {...a11y} />
}

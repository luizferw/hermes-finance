// A template (not a layout) re-mounts on every navigation, so this wraps each
// page in a one-shot entrance. Subtle rise + fade; collapses to instant under
// prefers-reduced-motion via the global guard in globals.css.
export default function AppTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  // flex-col / flex-1 mirrors SidebarInset's content slot so wrapping pages here
  // doesn't disturb their height/sticky layout.
  return <div className="page-in flex min-h-0 w-full flex-1 flex-col">{children}</div>;
}

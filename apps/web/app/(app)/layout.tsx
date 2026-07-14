import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getInboxCount } from "@/modules/transactions/queries";
import { isOnboarded } from "@/modules/onboarding/queries";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { MobileBottomNav } from "@/components/app-shell/mobile-bottom-nav";
import { CommandMenuProvider } from "@/components/command-menu/command-menu";
import { InboxCountProvider } from "@/components/app-shell/chrome-context";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (!(await isOnboarded(user.id))) redirect("/onboarding");
  const inboxCount = await getInboxCount(user.id);

  return (
    <InboxCountProvider value={inboxCount}>
      <CommandMenuProvider>
        <SidebarProvider>
          <AppSidebar
            user={{ name: user.name, email: user.email }}
            inboxCount={inboxCount}
          />
          <SidebarInset className="app-atmosphere min-w-0 pb-16 md:pb-0">
            {children}
          </SidebarInset>
          {/* The room's material — a whisper of grain over everything, below
              portalled overlays. Sits in the shell so every screen shares it. */}
          <div aria-hidden className="app-grain" />
          <MobileBottomNav />
        </SidebarProvider>
      </CommandMenuProvider>
    </InboxCountProvider>
  );
}

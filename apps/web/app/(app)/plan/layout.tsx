import { PageHeader } from "@/components/app-shell/page-header";
import { PlanTabs } from "./plan-tabs";

export default function PlanLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader
        title="Future"
        description="Where you're headed — goals, commitments, and what's ahead"
      />
      <div className="px-4 pt-4 md:px-6">
        <PlanTabs />
      </div>
      <main className="p-4 md:p-6">{children}</main>
    </>
  );
}

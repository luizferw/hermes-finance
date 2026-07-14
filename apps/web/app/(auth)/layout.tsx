import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { BrandWordmark } from "@/components/brand";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (session) redirect("/overview");

  return (
    <div className="relative flex min-h-svh flex-col">
      {/* Quiet ledger-grid backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-40 [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]"
      />
      <header className="relative z-10 flex h-16 items-center px-6">
        <Link href="/" aria-label="Kosh home">
          <BrandWordmark />
        </Link>
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-24">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}

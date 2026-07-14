import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { isOnboarded } from "@/modules/onboarding/queries";
import { BrandWordmark } from "@/components/brand";

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  if (await isOnboarded(user.id)) redirect("/overview");

  return (
    <div className="relative flex min-h-svh flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-40 [mask-image:radial-gradient(ellipse_70%_50%_at_50%_0%,black,transparent)]"
      />
      <header className="relative z-10 flex h-16 items-center px-6">
        <BrandWordmark />
      </header>
      <main className="relative z-10 flex flex-1 items-start justify-center px-4 pb-24 pt-2">
        <div className="w-full max-w-xl">{children}</div>
      </main>
    </div>
  );
}

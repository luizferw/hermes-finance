import type { Metadata } from "next";
import { OnboardingWizard } from "./onboarding-wizard";

export const metadata: Metadata = { title: "Welcome to Kosh" };

export default function OnboardingPage() {
  return <OnboardingWizard />;
}

import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  const showDemo = process.env.NODE_ENV !== "production";
  return <LoginForm showDemo={showDemo} />;
}

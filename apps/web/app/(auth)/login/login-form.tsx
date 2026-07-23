"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  AuthError,
  AuthHeader,
  AuthInput,
  AuthLabel,
  PasswordInput,
} from "@/components/auth/auth-ui";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

type FormValues = z.infer<typeof schema>;

export function LoginForm({ showDemo = false }: { showDemo?: boolean }) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    const { error } = await signIn.email({
      email: values.email,
      password: values.password,
    });
    if (error) {
      setServerError("Could not sign in. Check your email and password.");
      return;
    }
    router.push("/overview");
    router.refresh();
  });

  return (
    <div className="space-y-8">
      <AuthHeader title="Sign in" description="Enter your credentials to continue." />

      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={!!errors.email}>
            <AuthLabel htmlFor="email">Email</AuthLabel>
            <AuthInput
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              aria-invalid={!!errors.email}
              {...form.register("email")}
            />
            {errors.email && <FieldError>{errors.email.message}</FieldError>}
          </Field>

          <Field data-invalid={!!errors.password}>
            <AuthLabel htmlFor="password">Password</AuthLabel>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              aria-invalid={!!errors.password}
              {...form.register("password")}
            />
            {errors.password && (
              <FieldError>{errors.password.message}</FieldError>
            )}
          </Field>

          {serverError && <AuthError>{serverError}</AuthError>}

          <Button
            type="submit"
            className="h-11 w-full text-sm"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting && <Spinner />}
            Sign in
          </Button>
        </FieldGroup>
      </form>

      {showDemo && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Demo —{" "}
          <span className="font-amount text-foreground">demo@kosh.local</span> /{" "}
          <span className="font-amount text-foreground">demo1234</span>
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        No account?{" "}
        <Link
          href="/register"
          className="rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}

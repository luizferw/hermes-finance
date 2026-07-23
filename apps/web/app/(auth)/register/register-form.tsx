"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { signUp } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
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

const MIN_PASSWORD = 8;

const schema = z
  .object({
    name: z.string().min(2, "Tell us what to call you"),
    email: z.string().email("Enter a valid email"),
    password: z.string().min(
      MIN_PASSWORD,
      `At least ${MIN_PASSWORD} characters`,
    ),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    path: ["confirm"],
    message: "Passwords do not match",
  });

type FormValues = z.infer<typeof schema>;

export function RegisterForm() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "", confirm: "" },
  });
  const errors = form.formState.errors;

  const password = useWatch({ control: form.control, name: "password" });
  const passwordMet = password.length >= MIN_PASSWORD;

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    const { error } = await signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
    });
    if (error) {
      setServerError(error.message ?? "Could not create the account.");
      return;
    }
    router.push("/overview");
    router.refresh();
  });

  return (
    <div className="space-y-8">
      <AuthHeader
        title="Create account"
        description="Your account is stored on this server, not a Kosh cloud."
      />

      <form onSubmit={onSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={!!errors.name}>
            <AuthLabel htmlFor="name">Name</AuthLabel>
            <AuthInput
              id="name"
              autoComplete="name"
              autoFocus
              aria-invalid={!!errors.name}
              {...form.register("name")}
            />
            {errors.name && <FieldError>{errors.name.message}</FieldError>}
          </Field>

          <Field data-invalid={!!errors.email}>
            <AuthLabel htmlFor="email">Email</AuthLabel>
            <AuthInput
              id="email"
              type="email"
              autoComplete="email"
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
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              aria-describedby="password-hint"
              {...form.register("password")}
            />
            {errors.password ? (
              <FieldError>{errors.password.message}</FieldError>
            ) : (
              <p
                id="password-hint"
                className={cn(
                  "flex items-center gap-1.5 text-xs/relaxed transition-colors",
                  passwordMet ? "text-success" : "text-muted-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={Tick02Icon}
                  className={cn(
                    "size-3.5 transition-opacity",
                    passwordMet ? "opacity-100" : "opacity-30",
                  )}
                />
                At least {MIN_PASSWORD} characters
              </p>
            )}
          </Field>

          <Field data-invalid={!!errors.confirm}>
            <AuthLabel htmlFor="confirm">Confirm password</AuthLabel>
            <PasswordInput
              id="confirm"
              autoComplete="new-password"
              aria-invalid={!!errors.confirm}
              {...form.register("confirm")}
            />
            {errors.confirm && (
              <FieldError>{errors.confirm.message}</FieldError>
            )}
          </Field>

          {serverError && <AuthError>{serverError}</AuthError>}

          <Button
            type="submit"
            className="h-11 w-full text-sm"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting && <Spinner />}
            Create account
          </Button>
        </FieldGroup>
      </form>

      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/login"
          className="rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}

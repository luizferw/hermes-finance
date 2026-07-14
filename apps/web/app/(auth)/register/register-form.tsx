"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { signUp } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const schema = z
  .object({
    name: z.string().min(2, "Tell us what to call you"),
    email: z.string().email("Enter a valid email"),
    password: z.string().min(8, "At least 8 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
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

  const errors = form.formState.errors;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-2xl font-normal">
          Create your account
        </CardTitle>
        <CardDescription>
          One account per household member. Everything stays on this server.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" autoComplete="name" {...form.register("name")} />
              {errors.name && <FieldError>{errors.name.message}</FieldError>}
            </Field>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                {...form.register("email")}
              />
              {errors.email && <FieldError>{errors.email.message}</FieldError>}
            </Field>
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                {...form.register("password")}
              />
              {errors.password && (
                <FieldError>{errors.password.message}</FieldError>
              )}
            </Field>
            <Field data-invalid={!!errors.confirm}>
              <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                {...form.register("confirm")}
              />
              {errors.confirm && (
                <FieldError>{errors.confirm.message}</FieldError>
              )}
            </Field>
            {serverError && (
              <p role="alert" className="text-sm text-destructive">
                {serverError}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting && <Spinner />}
              Create account
            </Button>
          </FieldGroup>
        </form>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

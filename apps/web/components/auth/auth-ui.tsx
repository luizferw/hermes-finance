"use client";

import * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/field";

export function AuthHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-2">
      <h1 className="font-serif text-3xl leading-none font-normal tracking-[-0.01em] text-foreground">
        {title}
      </h1>
      <p className="text-sm leading-relaxed text-balance text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

export function AuthLabel(props: React.ComponentProps<typeof FieldLabel>) {
  return <FieldLabel {...props} className={cn("text-sm", props.className)} />;
}

export const AuthInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input>
>(function AuthInput({ className, ...props }, ref) {
  return (
    <Input
      ref={ref}
      className={cn("h-10 px-3 text-sm md:text-sm", className)}
      {...props}
    />
  );
});

export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input>
>(function PasswordInput({ className, ...props }, ref) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <AuthInput
        ref={ref}
        type={show ? "text" : "password"}
        className={cn("pr-10", className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        className="absolute inset-y-0 right-0 flex items-center rounded-r-md px-3 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
      >
        <HugeiconsIcon
          icon={show ? ViewOffSlashIcon : ViewIcon}
          className="size-4"
        />
      </button>
    </div>
  );
});

export function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm leading-relaxed text-destructive"
    >
      {children}
    </p>
  );
}

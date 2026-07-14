import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

const ALLOWED_ELEMENTS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "del",
  "blockquote",
  "code",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
  "hr",
  "br",
  "input",
];

export function safeMarkdownUrl(url: string): string {
  const transformed = defaultUrlTransform(url);
  if (!transformed) return "";
  try {
    const protocol = new URL(transformed).protocol;
    return protocol === "https:" ? transformed : "";
  } catch {
    return "";
  }
}

const components: Components = {
  h1: ({ children }) => <h2 className="mt-5 text-lg font-semibold tracking-tight first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="mt-5 text-base font-semibold tracking-tight first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 text-sm font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-4 text-sm font-medium first:mt-0">{children}</h5>,
  p: ({ children }) => <p className="my-2 leading-6 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>,
  li: ({ children }) => <li className="pl-1 leading-6">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 rounded-r-lg border-l border-border bg-muted/50 py-1 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => (
    <code className={className ?? "rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]"}>{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 max-w-full overflow-x-auto rounded-xl bg-muted p-3 font-mono text-[0.8125rem] leading-5">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 max-w-full overflow-x-auto rounded-xl border border-border/70">
      <table className="w-full min-w-[30rem] border-collapse text-left text-[0.8125rem]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border bg-muted/60 px-3 py-2 font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-border/60 px-3 py-2 align-top last:border-b-0">{children}</td>,
  a: ({ href, children }) =>
    href && safeMarkdownUrl(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium text-primary underline decoration-primary/35 underline-offset-4 hover:decoration-primary"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  hr: () => <hr className="my-4 border-border/70" />,
  input: (props) => <input {...props} disabled className="mr-2 accent-primary" />,
};

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="max-w-[72ch] break-words text-sm text-foreground [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        allowedElements={ALLOWED_ELEMENTS}
        components={components}
        urlTransform={safeMarkdownUrl}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

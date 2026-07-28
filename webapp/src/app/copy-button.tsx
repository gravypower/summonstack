"use client";

import { useState } from "react";

interface CopyButtonProps {
  text: string;
  label?: string;
  className?: string;
}

export default function CopyButton({ text, label = "Copy", className = "btn secondary small" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" onClick={handleCopy} className={className} title="Copy to clipboard">
      {copied ? "Copied! ✓" : label}
    </button>
  );
}

export function CopySnippet({ text, children, className = "code-copy-bar" }: { text?: string; children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copyText = text || (typeof children === "string" ? children : String(children));

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={className}>
      <code className="mono">{children || text}</code>
      <button type="button" onClick={handleCopy} className="btn secondary small" style={{ marginLeft: "0.5rem", flexShrink: 0 }}>
        {copied ? "Copied! ✓" : "Copy"}
      </button>
    </div>
  );
}

export function ClickToCopy({ text, children }: { text?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copyText = text || (typeof children === "string" ? children : String(children));

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span
      onClick={handleCopy}
      className={`mono click-to-copy ${copied ? "copied" : ""}`}
      title="Click to copy command"
    >
      {children || text}
      <span className="copy-icon">{copied ? " ✓" : " 📋"}</span>
    </span>
  );
}

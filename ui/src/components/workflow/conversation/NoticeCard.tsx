"use client";

import { AlertTriangle, ExternalLink, MicOff, UserRoundCog } from "lucide-react";

import { cn } from "@/lib/utils";

type NoticeTone = "warning" | "error" | "supervisor";

interface NoticeCardProps {
    tone: NoticeTone;
    title: string;
    text: string;
    linkHref?: string;
    linkLabel?: string;
}

const TONE_STYLES: Record<NoticeTone, {
    icon: typeof AlertTriangle;
    container: string;
    iconColor: string;
    title: string;
    text: string;
    link: string;
}> = {
    warning: {
        icon: MicOff,
        container: "border-amber-500/20 bg-amber-500/10",
        iconColor: "text-amber-500",
        title: "text-amber-700 dark:text-amber-400",
        text: "text-amber-600 dark:text-amber-300",
        link: "text-amber-600 dark:text-amber-400",
    },
    error: {
        icon: AlertTriangle,
        container: "border-red-500/20 bg-red-500/10",
        iconColor: "text-red-500",
        title: "text-red-700 dark:text-red-400",
        text: "text-red-600 dark:text-red-300",
        link: "text-red-600 dark:text-red-400",
    },
    supervisor: {
        icon: UserRoundCog,
        container: "border-violet-500/20 bg-violet-500/10",
        iconColor: "text-violet-500",
        title: "text-violet-700 dark:text-violet-400",
        text: "text-violet-600 dark:text-violet-300",
        link: "text-violet-600 dark:text-violet-400",
    },
};

export function NoticeCard({
    tone,
    title,
    text,
    linkHref,
    linkLabel,
}: NoticeCardProps) {
    const styles = TONE_STYLES[tone];
    const Icon = styles.icon;

    return (
        <div
            className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2",
                styles.container,
            )}
        >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", styles.iconColor)} />
            <div className="min-w-0 flex-1">
                <div className={cn("text-xs font-medium", styles.title)}>
                    {title}
                </div>
                {text ? (
                    <div className={cn("mt-0.5 break-words text-sm", styles.text)}>
                        {text}
                    </div>
                ) : null}
                {linkHref && linkLabel ? (
                    <a
                        href={linkHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            "mt-1 inline-flex items-center gap-1 text-xs hover:underline",
                            styles.link,
                        )}
                    >
                        {linkLabel} <ExternalLink className="h-3 w-3" />
                    </a>
                ) : null}
            </div>
        </div>
    );
}

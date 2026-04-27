import { Show } from "@clerk/react";
import { Redirect } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function RequireSignedIn({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Redirect to={`${basePath}/sign-in`} />
      </Show>
    </>
  );
}

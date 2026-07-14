"use client";

import * as React from "react";

/**
 * App-chrome context. The masthead lives inside each page (so it can carry that
 * page's title and actions), but needs a couple of globally-known values — the
 * review queue size for the inbox indicator. The layout knows these once; this
 * hands them down without threading props through every page.
 */
const InboxCountContext = React.createContext(0);

export function InboxCountProvider({
  value,
  children,
}: {
  value: number;
  children: React.ReactNode;
}) {
  return (
    <InboxCountContext.Provider value={value}>
      {children}
    </InboxCountContext.Provider>
  );
}

export function useInboxCount() {
  return React.useContext(InboxCountContext);
}

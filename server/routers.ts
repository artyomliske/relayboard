import { z } from "zod";
import { eventSources, eventStatuses } from "../drizzle/schema";
import { getEventDetail } from "./db";
import { decideApproval, generateDemoEvent, getDashboardMetrics, getEventFeed, replayEvent } from "./relayboard";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  relayboard: router({
    metrics: publicProcedure.query(() => getDashboardMetrics()),
    events: publicProcedure
      .input(z.object({ status: z.enum(eventStatuses).optional() }).optional())
      .query(({ input }) => getEventFeed(input?.status)),
    event: publicProcedure.input(z.object({ eventId: z.string().uuid() })).query(({ input }) => getEventDetail(input.eventId)),
    generateDemo: publicProcedure.input(z.object({ source: z.enum(eventSources) })).mutation(({ input }) => generateDemoEvent(input.source)),
    decideApproval: publicProcedure
      .input(z.object({ eventId: z.string().uuid(), decision: z.enum(["approved", "rejected"]), comment: z.string().trim().min(1).max(1000) }))
      .mutation(({ input }) => decideApproval(input.eventId, input.decision, input.comment)),
    replay: publicProcedure.input(z.object({ eventId: z.string().uuid() })).mutation(({ input }) => replayEvent(input.eventId)),
  }),
});

export type AppRouter = typeof appRouter;

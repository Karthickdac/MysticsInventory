export interface SubscriptionPlanDef {
  id: string;
  name: string;
  priceMonthlyInPaise: number;
  currency: string;
  features: string[];
  razorpayPlanId: string | null;
}

export const PLANS: SubscriptionPlanDef[] = [
  {
    id: "free",
    name: "Free",
    priceMonthlyInPaise: 0,
    currency: "INR",
    features: [
      "Up to 50 items",
      "1 warehouse",
      "Basic reports",
      "Single user",
    ],
    razorpayPlanId: null,
  },
  {
    id: "starter",
    name: "Starter",
    priceMonthlyInPaise: 49900,
    currency: "INR",
    features: [
      "Up to 1,000 items",
      "Up to 3 warehouses",
      "All reports",
      "Up to 5 users",
      "Email support",
    ],
    razorpayPlanId: process.env.RAZORPAY_PLAN_STARTER ?? null,
  },
  {
    id: "growth",
    name: "Growth",
    priceMonthlyInPaise: 149900,
    currency: "INR",
    features: [
      "Unlimited items",
      "Unlimited warehouses",
      "Shopify integration",
      "Up to 25 users",
      "Priority support",
    ],
    razorpayPlanId: process.env.RAZORPAY_PLAN_GROWTH ?? null,
  },
  {
    id: "scale",
    name: "Scale",
    priceMonthlyInPaise: 399900,
    currency: "INR",
    features: [
      "Everything in Growth",
      "Unlimited users",
      "Custom integrations",
      "Dedicated success manager",
    ],
    razorpayPlanId: process.env.RAZORPAY_PLAN_SCALE ?? null,
  },
];

export function getPlan(id: string): SubscriptionPlanDef | undefined {
  return PLANS.find((p) => p.id === id);
}

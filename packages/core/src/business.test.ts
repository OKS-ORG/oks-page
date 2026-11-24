// The business's structured data (spec 19, section 3; BZ-01): what is written, what is left out, and that nothing the owner
// typed can put anything but text into a page's head.
import { describe, expect, test } from "vitest";
import { jsonLd } from "./seo-meta.js";
import { localBusinessStructuredData, ratingOf, readBusiness } from "./business.js";

const SETTINGS = {
  name: "Weber Garden Cafe",
  type: "Cafe",
  street: "Lindenstrasse 4",
  postal: "10115",
  city: "Berlin",
  country: "de",
  phone: "+49 30 1234567",
  email: "hello@weber.example",
  social:
    "https://www.instagram.com/webergarden, http://insecure.example, javascript:alert(1), https://facebook.com/webergarden",
  hours_mon: "09:00-17:00",
  hours_fri: "10:00-24:00",
  special_days: "2026-12-25 closed Christmas Day; 2026-12-24 09:00-12:00",
};

describe("LocalBusiness structured data", () => {
  const data = (over: Record<string, unknown> = {}) =>
    localBusinessStructuredData(
      readBusiness({ ...SETTINGS, ...over })!,
      "https://garden.example/",
    ) as Record<string, unknown>;

  test("the name, address, contact details, pages elsewhere and the hours, as search engines read them", () => {
    const d = data();
    expect(d).toMatchObject({
      "@context": "https://schema.org",
      "@type": "CafeOrCoffeeShop",
      name: "Weber Garden Cafe",
      url: "https://garden.example/",
      telephone: "+49 30 1234567",
      email: "hello@weber.example",
      address: {
        "@type": "PostalAddress",
        streetAddress: "Lindenstrasse 4",
        postalCode: "10115",
        addressLocality: "Berlin",
        addressCountry: "DE",
      },
    });
    expect(d["openingHoursSpecification"]).toEqual([
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Monday",
        opens: "09:00",
        closes: "17:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: "Friday",
        opens: "10:00",
        closes: "23:59",
      },
      // A closed special day is written as a day that opens and closes at the same time; a shorter day has its hours.
      {
        "@type": "OpeningHoursSpecification",
        validFrom: "2026-12-25",
        validThrough: "2026-12-25",
        opens: "00:00",
        closes: "00:00",
      },
      {
        "@type": "OpeningHoursSpecification",
        validFrom: "2026-12-24",
        validThrough: "2026-12-24",
        opens: "09:00",
        closes: "12:00",
      },
    ]);
  });

  test("only https addresses are pages elsewhere; the kind of business falls back to LocalBusiness", () => {
    expect(data()["sameAs"]).toEqual([
      "https://www.instagram.com/webergarden",
      "https://facebook.com/webergarden",
    ]);
    expect(data({ type: "Spaceship repair" })["@type"]).toBe("LocalBusiness");
    expect(data({ type: "" })["@type"]).toBe("LocalBusiness");
  });

  test("what was not entered is left out, not written empty", () => {
    const d = data({
      street: "",
      city: "",
      postal: "",
      phone: "",
      email: "x",
      social: "",
      hours_mon: "",
      hours_fri: "",
      special_days: "",
    });
    expect(d).toEqual({
      "@context": "https://schema.org",
      "@type": "CafeOrCoffeeShop",
      name: "Weber Garden Cafe",
      url: "https://garden.example/",
    });
  });

  test("BZ-03: the rating appears only when approved reviews were counted, rounded to one place", () => {
    const b = readBusiness(SETTINGS)!;
    expect(localBusinessStructuredData(b, "https://g.example")).not.toHaveProperty(
      "aggregateRating",
    );
    expect(
      localBusinessStructuredData(
        { ...b, rating: { value: 4.666, count: 3 } },
        "https://g.example",
      ),
    ).toMatchObject({
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: "4.7",
        reviewCount: 3,
        bestRating: "5",
        worstRating: "1",
      },
    });
    expect(
      localBusinessStructuredData({ ...b, rating: { value: 0, count: 0 } }, "https://g.example"),
    ).not.toHaveProperty("aggregateRating");
  });

  test("only approved reviews with a whole number of stars from 1 to 5 count", () => {
    expect(
      ratingOf([
        { status: "approved", stars: 5 },
        { status: "approved", stars: 4 },
        { status: "pending", stars: 1 },
        { status: "rejected", stars: 1 },
        { status: "spam", stars: 1 },
        { status: "approved", stars: 6 },
        { status: "approved", stars: 0 },
        { status: "approved", stars: 4.5 },
        { status: "approved", stars: "5" },
        null,
        "x",
      ]),
    ).toEqual({ value: 4.5, count: 2 });
    expect(ratingOf([])).toBeUndefined();
  });

  test("text that tries to end the script tag cannot (it goes through the same escaping as every page)", () => {
    const text = jsonLd([data({ name: "</script><script>alert(1)</script>" })]);
    expect(text).not.toContain("</script>");
    expect(text).toContain("\\u003c");
  });
});

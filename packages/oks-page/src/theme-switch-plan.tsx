// The list the owner reads before switching themes (spec 05, section 17.7): what is kept, what stays with the old
// theme, and which pages will use another layout. It only shows; the buttons live in the Themes screen.
import type { ThemeSwitchPlan } from "@oks-page/core";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sentence = (items: string[]) => items.join(", ");

export function SwitchPlan({ plan }: { plan: ThemeSwitchPlan }) {
  const { kept, stays, pagesMoved, comesBack } = plan;
  const keptLines = [
    `All your content: ${plural(kept.pages, "page or post", "pages and posts")} and ${plural(kept.media, "file", "files")} in the media library.`,
    "Your menus, kept by place (header, footer).",
    kept.savedSections > 0
      ? `Your ${plural(kept.savedSections, "saved section", "saved sections")}.`
      : "Your saved sections, if you make any.",
    "Your site name.",
    `Your ${kept.mainColor ? "main color, " : ""}fonts${kept.logo ? " and logo" : ""}: they belong to your site, so the new look uses them too.`,
  ];
  if (kept.customCss)
    keptLines.push(
      "Your own CSS. It is kept and switched off, because it was written for the theme you use now. You can switch it on again on the Look screen once you have looked at the new theme.",
    );
  const nothingStays = stays.changedLayouts.length === 0 && stays.ownerLayouts.length === 0;
  return (
    <section aria-label={`Switching to ${plan.to.name}`}>
      <h3>{`Switching from ${plan.from.name} to ${plan.to.name}`}</h3>
      <h4>Kept</h4>
      <ul>
        {keptLines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h4>{`Stays with ${plan.from.name}`}</h4>
      {nothingStays ? (
        <p>You have not changed any layout, so nothing is left behind.</p>
      ) : (
        <>
          <ul>
            {stays.changedLayouts.length > 0 ? (
              <li>{`Your changes to these layouts: ${sentence(stays.changedLayouts)}.`}</li>
            ) : null}
            {stays.ownerLayouts.length > 0 ? (
              <li>{`Layouts you made: ${sentence(stays.ownerLayouts)}.`}</li>
            ) : null}
          </ul>
          <p>
            They are not lost. If you switch back to {plan.from.name}, they are there again as you
            left them.
          </p>
        </>
      )}
      {pagesMoved.total > 0 ? (
        <>
          <h4>{`${plural(pagesMoved.total, "page", "pages")} will use the Page layout`}</h4>
          <p>These pages chose a layout you made. The new theme does not have it.</p>
          <ul>
            {pagesMoved.pages.map((page) => (
              <li key={page.id}>{page.title}</li>
            ))}
            {pagesMoved.total > pagesMoved.pages.length ? (
              <li>{`and ${pagesMoved.total - pagesMoved.pages.length} more`}</li>
            ) : null}
          </ul>
        </>
      ) : null}
      {comesBack.changedLayouts + comesBack.ownerLayouts > 0 ? (
        <>
          <h4>{`Comes back from earlier with ${plan.to.name}`}</h4>
          <p>
            You used this theme before. Your layout changes there ({comesBack.changedLayouts}) and
            layouts you made ({comesBack.ownerLayouts}) are used again.
          </p>
        </>
      ) : null}
    </section>
  );
}

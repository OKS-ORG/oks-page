// The standard words of the consent notice, used while the site has not sent its own (they are the same as the defaults in
// @oks-page/core, kept here so the notice does not pull the server code into the browser).
export interface NoticeTexts {
  title: string;
  intro: string;
  accept: string;
  refuse: string;
  save: string;
  reopen: string;
}

export const NOTICE_TEXTS: NoticeTexts = {
  title: "Your privacy choices",
  intro:
    "This site would like to use the following. Nothing in this list is used unless you agree, and you can change your mind at any time with the “Privacy choices” button.",
  accept: "Accept all",
  refuse: "Refuse all",
  save: "Save my choices",
  reopen: "Privacy choices",
};

// Oneforall Social Manager — Auth0 Post Login Action
// Deploy this Action in Auth0 and add it to the Login Flow.
// It places the normalized authenticated email in the namespaced claim
// expected by the Social Manager backend.

exports.onExecutePostLogin = async (event, api) => {
  const email = event.user?.email?.trim().toLowerCase();
  if (!email) return;

  api.accessToken.setCustomClaim(
    'https://oneforall.ocloud.click/email',
    email
  );
};

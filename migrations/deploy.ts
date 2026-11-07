// Anchor's migration hook. The workspace's previous contents imported
// `@anchor-lang/core`, the legacy JS client this project no longer depends on.
//
// Deployment is done with the Anchor CLI (`anchor deploy`), and everything the
// app needs at runtime lives in `pkgs/client` (Kit) and `pkgs/sdk`. This hook
// therefore intentionally does nothing - it exists only because the CLI looks
// for it.

module.exports = async function () {
  // No post-deploy steps. See README for the deploy and codegen workflow.
};

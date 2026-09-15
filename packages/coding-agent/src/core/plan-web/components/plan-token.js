export const planToken = location.hash.slice(1) || sessionStorage.getItem("pi-plan-token") || "";

sessionStorage.setItem("pi-plan-token", planToken);
history.replaceState(null, "", location.pathname);

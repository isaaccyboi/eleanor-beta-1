import { getUser } from "./user.js";

export function isAdmin(id) {
  const user = getUser(id);
  return user?.name === "Ada";
}

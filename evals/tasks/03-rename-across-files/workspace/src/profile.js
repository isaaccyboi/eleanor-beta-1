import { getUser } from "./user.js";

export function profileLine(id) {
  const user = getUser(id);
  return user ? `Profile: ${user.name}` : "Profile: unknown";
}

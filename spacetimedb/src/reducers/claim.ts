import spacetimedb from "../schema";
import { t } from "spacetimedb/server";
import { ScheduleAt, Timestamp } from "spacetimedb";
import {
  CLAIM_CODE_TTL_MS,
  elapsedMs,
  getZone,
  isGeneratedName,
} from "../../../shared/index";
import {
  isSpacetimeAuthCaller,
  nameTaken,
  solidTiles,
  ownedInventoryRow,
  equippedInventoryRow,
  moveInventory,
  placeCarried,
  facingDir,
} from "../helpers";

/** A claim nonce is a v4 UUID minted by the client (`crypto.randomUUID`). */
const CLAIM_CODE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step 1 of the guest → account upgrade (GDD "Identity"). Called while connected
 * as a guest: register the browser-minted nonce under the guest's own identity so
 * a later `redeemClaim` can authorise migrating this trogg. Only a guest with a
 * live trogg may start a claim; any previous pending code for this guest is
 * replaced so only the latest attempt is redeemable.
 */
export const startClaim = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p || !p.isGuest) return;
  if (!CLAIM_CODE_RE.test(code)) return; // client mints a UUID (crypto.randomUUID); reject anything else

  for (const existing of ctx.db.claimCode.iter()) {
    if (existing.guest.isEqual(ctx.sender)) ctx.db.claimCode.code.delete(existing.code);
  }
  ctx.db.claimCode.insert({ code, guest: ctx.sender, createdAt: ctx.timestamp });
});

/**
 * Step 2 of the guest → account upgrade. Called after signing in, now connected
 * as the SpacetimeAuth identity. Trust only a real SpacetimeAuth caller (invariant
 * 3) and a fresh, matching nonce; then fold the guest trogg into this account: the
 * guest's chosen name carries over (unless this account already chose one), and
 * the guest row is removed so the world shows one trogg. The account row itself was
 * created by `clientConnected` on this connection (or already existed on return).
 */
export const redeemClaim = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  if (!isSpacetimeAuthCaller(ctx)) return;

  const pending = ctx.db.claimCode.code.find(code);
  if (!pending) return;
  // Always consume the nonce, even if it's stale or the guest is gone.
  ctx.db.claimCode.code.delete(code);
  if (elapsedMs(pending.createdAt, ctx.timestamp) > CLAIM_CODE_TTL_MS) return;

  const guest = ctx.db.player.identity.find(pending.guest);
  const account = ctx.db.player.identity.find(ctx.sender);
  if (!guest || !account || guest.identity.isEqual(account.identity)) return;

  // Fold the guest's carried entity into the account too — it exists only as the guest
  // row's `carrying` (its world row was deleted on pickup), so deleting the guest without
  // this would destroy it (GDD "Interacting": nothing is orphaned). If the account is
  // already carrying, drop the guest's into the world where it stood instead.
  let carrying = account.carrying;
  let carryingStyle = account.carryingStyle;
  if (guest.carrying !== "") {
    if (carrying === "") {
      carrying = guest.carrying;
      carryingStyle = guest.carryingStyle;
    } else {
      const zone = getZone(guest.zoneId);
      const occupied = solidTiles(ctx, guest.zoneId, ctx.timestamp, guest.identity);
      const face = facingDir(guest);
      if (zone) placeCarried(ctx, zone, guest.carrying, guest.carryingStyle, occupied, guest.x, guest.y, face.dirX, face.dirY);
    }
  }

  // Remove the guest row before checking name availability, so the name it's handing over
  // isn't counted as taken by the guest itself — otherwise a guest that renamed before
  // signing up could never carry that chosen name onto its account.
  const guestName = guest.name;
  ctx.db.player.identity.delete(guest.identity);

  // Carry the guest's chosen name onto a freshly-named account (never clobber a
  // returning account's own name), staying within the uniqueness rule.
  const inheritName = !isGeneratedName(guestName) && isGeneratedName(account.name) && !nameTaken(ctx, guestName, ctx.sender);
  const movedInventoryIds = moveInventory(ctx, guest.identity, account.identity);
  const accountEquipped = equippedInventoryRow(ctx, account);
  const guestEquippedId = movedInventoryIds.get(guest.equippedMainHandInventoryId) ?? 0n;
  const guestEquipped = guestEquippedId !== 0n ? ownedInventoryRow(ctx, account.identity, guestEquippedId) : undefined;
  const equippedMainHand = accountEquipped?.item ?? guestEquipped?.item ?? "";
  const equippedMainHandInventoryId = accountEquipped?.id ?? guestEquipped?.id ?? 0n;
  ctx.db.player.identity.update({
    ...account,
    name: inheritName ? guestName : account.name,
    carrying,
    carryingStyle,
    equippedMainHand,
    equippedMainHandInventoryId,
    isGuest: false,
  });
});


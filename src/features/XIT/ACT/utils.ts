export function isValidPackageName(name: string) {
  return /^[ 0-9a-zA-Z.-]*$/.test(name);
}

export function stripDeletedActions(pkg: UserData.ActionPackageData) {
  pkg.actions = pkg.actions.filter(x => !x.deleted);
}

// .github/scripts/update-status.js
// ESM module. Called from actions/github-script with a GitHub App installation token.
//
// What it does:
// 1) Reads the REPO Issue Type (sidebar pill) for the current issue
// 2) If it equals TARGET_TYPE, finds the linked Project V2 item in PROJECT_NUMBER
// 3) Updates the project's STATUS_FIELD_NAME to NEW_STATUS_VALUE

// ======= CONFIG — CHANGE THESE TO MATCH YOUR PROJECT =======
const PROJECT_NUMBER = 1; // e.g., .../projects/1 (UPDATE THIS)
const TARGET_TYPE = "Milestone"; // repo Issue Type to check (case-sensitive)
const STATUS_FIELD_NAME = "Status"; // Project field to update
const NEW_STATUS_VALUE = "Milestones"; // Option name in Status (case-sensitive)
// ===========================================================

export default async function run({ github, context, core }) {
  const owner = context.repo.owner; // org login for org-owned repos
  const repo = context.repo.repo;
  const issueNumber = context.payload.issue.number;

  try {
    // 0) Read REPO Issue Type (this matches the pill in the issue sidebar)
    const issueInfo = await github.graphql(
      `
      query($owner:String!, $repo:String!, $number:Int!){
        repository(owner:$owner, name:$repo){
          issue(number:$number){
            id
            number
            issueType { name }      # <-- repo Issue Type (not a Project field)
            projectItems(first:50){
              nodes { id project { number } }
            }
          }
        }
      }
      `,
      { owner, repo, number: issueNumber },
    );

    const issue = issueInfo.repository.issue;
    const repoIssueType = issue?.issueType?.name || null;
    core.info(`Repo Issue Type: ${repoIssueType ?? "(none)"}`);
    if (repoIssueType !== TARGET_TYPE) {
      core.info(`Type is not '${TARGET_TYPE}'. No Status change.`);
      return;
    }

    // 1) Resolve org-level Project V2 ID
    //    (Projects V2 live at org level even when "linked" to repos)
    const org = owner;
    const proj = await github.graphql(
      `
      query($org:String!, $projectNumber:Int!){
        organization(login:$org){
          projectV2(number:$projectNumber){ id }
        }
      }
      `,
      { org, projectNumber: PROJECT_NUMBER },
    );

    const projectId = proj.organization?.projectV2?.id;
    if (!projectId) {
      core.setFailed(
        `Project V2 #${PROJECT_NUMBER} not found in org '${org}'.`,
      );
      return;
    }

    // 2) Find the Project item for this issue within Project #PROJECT_NUMBER
    const projectItemId = issue.projectItems.nodes.find(
      (n) => n.project?.number === PROJECT_NUMBER,
    )?.id;

    if (!projectItemId) {
      core.info(
        `Issue #${issueNumber} is not in Project ${PROJECT_NUMBER}. Skipping.`,
      );
      return;
    }

    // 3) Fetch Project fields and options (union-safe, parse-safe)
    const fieldMeta = await github.graphql(
      `query GetProjectFields($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 100) {
              nodes {
                __typename
                ... on ProjectV2FieldCommon { id name }
                ... on ProjectV2SingleSelectField { options { id name } }
              }
            }
          }
        }
      }`,
      { projectId },
    );

    const statusField = fieldMeta.node.fields.nodes.find(
      (f) => f.name === STATUS_FIELD_NAME,
    );
    if (!statusField) {
      core.setFailed(
        `Field '${STATUS_FIELD_NAME}' not found in Project ${PROJECT_NUMBER}.`,
      );
      return;
    }
    const option = (statusField.options || []).find(
      (o) => o.name === NEW_STATUS_VALUE,
    );
    if (!option) {
      core.setFailed(
        `Option '${NEW_STATUS_VALUE}' not found in field '${STATUS_FIELD_NAME}'.`,
      );
      return;
    }

    // 4) Update Status on the project item
    await github.graphql(
      `
      mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!){
        updateProjectV2ItemFieldValue(
          input:{
            projectId:$projectId
            itemId:$itemId
            fieldId:$fieldId
            value:{ singleSelectOptionId:$optionId }
          }
        ){
          projectV2Item { id }
        }
      }
      `,
      {
        projectId,
        itemId: projectItemId,
        fieldId: statusField.id,
        optionId: option.id,
      },
    );

    core.info(
      `Updated '${STATUS_FIELD_NAME}' → '${NEW_STATUS_VALUE}' for Issue #${issueNumber} (type '${TARGET_TYPE}').`,
    );
  } catch (err) {
    core.setFailed(`update-status.js failed: ${err?.message || String(err)}`);
  }
}

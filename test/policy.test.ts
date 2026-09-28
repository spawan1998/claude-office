import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, classifyBash, splitCommands } from "../src/policy.ts";

const WS = "/Users/pavan/Desktop/hilabs/claude-office/workspace";
const allow = (cmd: string) => assert.equal(classifyBash(cmd).kind, "allow", `expected allow: ${cmd}`);
const ask = (cmd: string) => assert.equal(classifyBash(cmd).kind, "ask", `expected ask: ${cmd}`);

test("non-destructive commands run without asking (reads AND writes)", () => {
  allow("kubectl get pods -n niq");
  allow("kubectl --context hilabs-dev-eks describe deploy x -n niq");
  allow("kubectl apply -f manifests.yaml -n niq");
  allow("kubectl scale deploy/x --replicas=0 -n y");
  allow("kubectl rollout restart deploy/x -n y");
  allow("kubectl patch deploy x -p '{}'");
  allow("kubectl config use-context prod");
  allow("kubectl exec -it pod -- sh");
  allow("kubectl logs -n niq deploy/x --tail=200 | grep -i error");
  allow("helm upgrade --install rel chart -n ns");
  allow("helm rollback rel 3 -n ns");
  allow("helm repo add x https://y");
  allow("argocd app sync niq");
  allow("aws ec2 describe-instances");
  allow("aws ec2 stop-instances --instance-ids i-1");
  allow("aws s3 cp file s3://bucket/");
  allow("aws s3 sync . s3://bucket/");
  allow("aws iam create-user --user-name x");
  allow("aws --profile dev eks update-kubeconfig --name hilabs-dev-eks");
  allow("git status && git log --oneline -20");
  allow("git add -A && git commit -am 'x' && git push origin main");
  allow("git checkout -b feat");
  allow("git stash");
  allow("git stash pop");
  allow("git restore --staged file");
  allow("curl -X POST https://x/api -d '{}'");
  allow("ssh jenkins@10.1.1.29 'ls'");
  allow("sudo systemctl restart nginx");
  allow("python3 script.py");
  allow("node -e 'console.log(1)'");
  allow("sed -i '' 's/a/b/' file");
  allow("echo hi > /tmp/file.txt");
  allow("cat a | tee b");
  allow("terraform plan -var-file=dev.tfvars && terraform apply -auto-approve");
  allow("docker run -it ubuntu");
  allow("docker build -t x . && docker push x");
  allow("docker compose down");
  allow("gh pr create --title x");
  allow("npm install");
  allow("brew install x");
  allow("mv a b && cp a c");
  allow("launchctl kickstart -k gui/501/com.x");
  allow("psql -c 'select * from t'");
  allow("git config --get remote.origin.url");
});

test("destructive / delete commands ask", () => {
  ask("rm -rf build/");
  ask("rm file");
  ask("rmdir x");
  ask("sudo rm -rf /tmp/x");
  ask("shred -u secret");
  ask("dd if=/dev/zero of=/dev/disk2");
  ask("kubectl delete pod x -n y");
  ask("kubectl --context prod -n niq delete deploy x");
  ask("kubectl drain node-1 --ignore-daemonsets");
  ask("kubectl apply -f x.yaml --prune -l app=x");
  ask("kubectl get pods; kubectl delete pod x");
  ask("kubectl delete pod $(kubectl get pods -o name | head -1)");
  ask("kubectl get pods -o name | xargs kubectl delete");
  ask("helm uninstall rel -n ns");
  ask("helm -n ns delete rel");
  ask("argocd app delete niq");
  ask("argocd app sync niq --prune");
  ask("aws ec2 terminate-instances --instance-ids i-1");
  ask("aws --profile dev s3 rm s3://bucket/key");
  ask("aws s3 rb s3://bucket --force");
  ask("aws s3 sync . s3://bucket/ --delete");
  ask("aws iam delete-user --user-name x");
  ask("aws cloudformation delete-stack --stack-name x");
  ask("aws ec2 deregister-image --image-id ami-1");
  ask("terraform destroy -auto-approve");
  ask("terraform state rm module.x");
  ask("git push -f origin main");
  ask("git push --force origin main");
  ask("git push --force-with-lease origin feat");
  ask("git push origin --delete feat");
  ask("git push origin :feat");
  ask("git branch -D old");
  ask("git branch -d old");
  ask("git tag -d v1");
  ask("git reset --hard HEAD~1");
  ask("git clean -fdx");
  ask("git checkout -- .");
  ask("git restore file.txt");
  ask("git stash drop");
  ask("git rebase -i HEAD~3");
  ask("docker rm -f c1");
  ask("docker rmi img");
  ask("docker system prune -af");
  ask("docker volume rm v1");
  ask("docker compose down -v");
  ask("gh repo delete x/y");
  ask("gh api -X DELETE repos/x/y/issues/1");
  ask("brew uninstall x");
  ask("npm uninstall x");
  ask("pip3 uninstall -y x");
  ask("launchctl bootout gui/501/com.x");
  ask("crontab -r");
  ask("find . -name '*.log' -delete");
  ask("find . -name '*.log' | xargs rm");
  ask("find . -name '*.tmp' -exec rm {} \;");
  ask("psql -c 'drop table users'");
  ask("mysql -e \"DELETE FROM orders WHERE 1=1\"");
  ask("python3 -c 'import shutil; shutil.rmtree(\"/tmp/x\")'");
  ask("node -e 'require(\"fs\").rmSync(\"x\",{recursive:true})'");
  ask("truncate -s 0 big.log");
});

test("file tools never ask", () => {
  assert.equal(classify("Write", { file_path: "/Users/pavan/Desktop/hilabs/hilabs-fuckups/ISSUE_LOG.md", content: "x" }, WS).kind, "allow");
  assert.equal(classify("Edit", { file_path: "/etc/hosts", old_string: "a", new_string: "b" }, WS).kind, "allow");
  assert.equal(classify("Read", { file_path: "/etc/hosts" }, WS).kind, "allow");
  assert.equal(classify("WebFetch", { url: "https://x" }, WS).kind, "allow");
  assert.equal(classify("SomethingNew", {}, WS).kind, "allow");
});

test("connector tools: only delete/remove/trash ask", () => {
  assert.equal(classify("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", { jql: "x" }, WS).kind, "allow");
  assert.equal(classify("mcp__claude_ai_Atlassian__createJiraIssue", {}, WS).kind, "allow");
  assert.equal(classify("mcp__claude_ai_Atlassian__addCommentToJiraIssue", {}, WS).kind, "allow");
  assert.equal(classify("mcp__claude_ai_Atlassian__transitionJiraIssue", {}, WS).kind, "allow");
  assert.equal(classify("mcp__claude_ai_Microsoft_365__outlook_send_mail", {}, WS).kind, "allow");
  assert.equal(classify("mcp__claude_ai_Microsoft_365__teams_send_chat_message", {}, WS).kind, "allow");
  assert.equal(classify("mcp__claude_ai_Microsoft_365__outlook_untrash_thread", {}, WS).kind, "allow");
  assert.equal(classify("mcp__claude_ai_Microsoft_365__outlook_trash_thread", {}, WS).kind, "ask");
  assert.equal(classify("mcp__claude_ai_Microsoft_365__outlook_batch_delete_messages", {}, WS).kind, "ask");
  assert.equal(classify("mcp__claude_ai_Microsoft_365__outlook_delete_event", {}, WS).kind, "ask");
  assert.equal(classify("mcp__claude_ai_Microsoft_365__sharepoint_delete_item", {}, WS).kind, "ask");
  assert.equal(classify("mcp__claude_ai_Claude_Docs__delete", {}, WS).kind, "ask");
});

test("tokenizer", () => {
  assert.deepEqual(splitCommands("a 'b c' | d \"e f\" && g; h"), [["a", "b c"], ["d", "e f"], ["g"], ["h"]]);
});

import { readOnlyViolation, writeReason } from "../src/policy.ts";

test("read-only mode: lookups pass, anything that changes state is a violation", () => {
  const okCmds = [
    "kubectl get pods -n niq", "kubectl --context hilabs-dev-eks describe deploy x -n niq", "kubectl logs deploy/x -n y --tail=100 | grep -i error",
    "aws --profile dev eks describe-cluster --name x", "aws s3 ls s3://b/", "git log --oneline -5", "git diff HEAD~1", "git branch -a",
    "helm list -n ns", "argocd app get x", "curl -s https://jenkins.hilabs.com/job/x/api/json | jq .color", "cat file | head", "docker ps",
  ];
  for (const c of okCmds) assert.equal(writeReason(c), null, `expected read-only: ${c}`);
  const bad = [
    "kubectl apply -f x.yaml", "kubectl scale deploy/x --replicas=0", "kubectl delete pod x", "kubectl exec -it p -- sh", "helm upgrade x y",
    "aws ec2 stop-instances --instance-ids i-1", "git push", "git commit -am x", "git checkout -b f", "echo hi > f", "sed -i '' s/a/b/ f",
    "rm x", "python3 s.py", "ssh host ls", "curl -X POST https://x", "npm install", "kubectl get pods | xargs kubectl delete",
    "kubectl delete pod $(kubectl get pods -o name)",
  ];
  for (const c of bad) assert.notEqual(writeReason(c), null, `expected violation: ${c}`);
  assert.equal(readOnlyViolation("Read", { file_path: "/etc/hosts" }), null);
  assert.equal(readOnlyViolation("Grep", {}), null);
  assert.equal(readOnlyViolation("WebFetch", {}), null);
  assert.notEqual(readOnlyViolation("Write", { file_path: "/tmp/x" }), null);
  assert.notEqual(readOnlyViolation("Edit", {}), null);
  assert.notEqual(readOnlyViolation("AskUserQuestion", {}), null);
  assert.equal(readOnlyViolation("mcp__claude_ai_Atlassian__getJiraIssue", {}), null);
  assert.equal(readOnlyViolation("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql", {}), null);
  assert.equal(readOnlyViolation("mcp__claude_ai_Microsoft_365__outlook_email_search", {}), null);
  assert.equal(readOnlyViolation("mcp__claude_ai_Microsoft_365__teams_list_chats", {}), null);
  assert.notEqual(readOnlyViolation("mcp__claude_ai_Atlassian__createJiraIssue", {}), null);
  assert.notEqual(readOnlyViolation("mcp__claude_ai_Atlassian__addCommentToJiraIssue", {}), null);
  assert.notEqual(readOnlyViolation("mcp__claude_ai_Microsoft_365__outlook_send_mail", {}), null);
  assert.notEqual(readOnlyViolation("mcp__claude_ai_Microsoft_365__teams_send_chat_message", {}), null);
  assert.notEqual(readOnlyViolation("mcp__claude_ai_Microsoft_365__outlook_create_reply_draft", {}), null);
});

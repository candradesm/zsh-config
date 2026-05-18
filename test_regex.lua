local function test(v)
  local v_major, v_minor, v_patch = v:match("^(%d+)%.(%d+)%.?(%d*)")
  print(v .. " -> major: " .. tostring(v_major) .. ", minor: " .. tostring(v_minor) .. ", patch: " .. tostring(v_patch))
end

test("2.3.0")
test("2.3")
test("1.9.24")
test("2.2")
test("2.3.255-SNAPSHOT")
